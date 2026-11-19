// Storage provider selection. Web and worker call `resolveStorageRuntimeConfig`
// + `buildStorageProvider` instead of importing a concrete adapter, so the
// active backend is a pure configuration choice. `local-fs` is the default —
// an install that configures nothing keeps working untouched; selecting `s3`
// with required settings missing fails fast at boot so a half-configured
// instance never silently writes nowhere.

import { access, constants, readdir } from 'node:fs/promises';
import path from 'node:path';
import { localFsStorageProvider } from './local-fs';
import { s3StorageProvider, type S3StorageOptions } from './s3';
import { assertSafeKey } from './safe-key';
import type { StorageProvider } from './index';

export interface LocalFsRuntimeConfig {
  provider?: 'local-fs';
  /** Local filesystem root (the mounted `/data` volume). */
  dataRoot: string;
  /** Base path for app-routed read URLs. */
  readUrlBase?: string;
}

export interface S3RuntimeConfig extends S3StorageOptions {
  provider: 's3';
}

export type StorageRuntimeConfig = LocalFsRuntimeConfig | S3RuntimeConfig;

/** A blank env value counts as unset, so templated env files with empty defaults parse. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

/** The container mount point; a host install sets `DATA_DIR` explicitly. */
const DEFAULT_DATA_ROOT = '/data';

const S3_REQUIRED_VARS = {
  region: 'S3_REGION',
  bucket: 'S3_BUCKET',
  accessKeyId: 'S3_ACCESS_KEY_ID',
  secretAccessKey: 'S3_SECRET_ACCESS_KEY',
} as const;

/**
 * Resolve the storage backend from env — the single config seam for web,
 * worker, and the seed script. Storage config is env-only (like the data
 * root); `local-fs` ignores the `S3_*` variables entirely.
 */
export function resolveStorageRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): StorageRuntimeConfig {
  const selection = envValue(env, 'STORAGE_PROVIDER') ?? 'local-fs';
  if (selection === 'local-fs') {
    const dataRoot = envValue(env, 'DATA_DIR') ?? DEFAULT_DATA_ROOT;
    // A relative root resolves against `process.cwd()`, which is a different
    // directory in dev, in the standalone server and in the worker. The tree
    // that gets written is then not the tree `delete()` unlinks from, and the
    // delete reports success either way — bytes leak silently and forever.
    if (!path.isAbsolute(dataRoot)) {
      throw new Error(
        'DATA_DIR must be an absolute path (it is resolved by more than one process)',
      );
    }
    return { provider: 'local-fs', dataRoot };
  }
  if (selection !== 's3') {
    throw new Error(`Unknown STORAGE_PROVIDER "${selection}" (expected "local-fs" or "s3")`);
  }

  const missing = Object.values(S3_REQUIRED_VARS).filter((name) => !envValue(env, name));
  if (missing.length > 0) {
    throw new Error(`STORAGE_PROVIDER=s3 requires ${missing.join(', ')} to be set`);
  }

  const endpoint = envValue(env, 'S3_ENDPOINT');
  const forcePathStyleRaw = envValue(env, 'S3_FORCE_PATH_STYLE');
  const keyPrefixRaw = envValue(env, 'S3_KEY_PREFIX')?.replace(/^\/+|\/+$/g, '');
  const keyPrefix = keyPrefixRaw ? assertSafeKey(keyPrefixRaw) : undefined;
  return {
    provider: 's3',
    region: envValue(env, S3_REQUIRED_VARS.region)!,
    bucket: envValue(env, S3_REQUIRED_VARS.bucket)!,
    accessKeyId: envValue(env, S3_REQUIRED_VARS.accessKeyId)!,
    secretAccessKey: envValue(env, S3_REQUIRED_VARS.secretAccessKey)!,
    forcePathStyle: forcePathStyleRaw === 'true' || forcePathStyleRaw === '1',
    ...(endpoint ? { endpoint } : {}),
    ...(keyPrefix ? { keyPrefix } : {}),
  };
}

/**
 * Boot-time check that the local storage directories are usable by this process.
 * Restored owner/session folders can have different permissions from DATA_DIR;
 * every existing directory must support reads, writes, and traversal.
 *
 * Never names the path: a boot log is the wrong place to publish the host's
 * layout, and the variable name is what the operator needs. S3 has no local
 * root, so this is a no-op there.
 */
export async function assertStorageRootWritable(config: StorageRuntimeConfig): Promise<void> {
  if (config.provider === 's3') return;
  try {
    await access(config.dataRoot, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (err) {
    const reason =
      (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'does not exist'
        : 'is not writable by the user this process runs as';
    // The filesystem error includes the private host path, so omit its cause.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`The storage root (DATA_DIR) ${reason}`);
  }

  const directories = [config.dataRoot];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    try {
      await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        // Never follow symlinks into another tree. Object operations enforce
        // their own confinement before reading or writing through a link.
        if (entry.isDirectory()) directories.push(path.join(directory, entry.name));
      }
    } catch (err) {
      // The running worker may prune an empty session folder during web boot.
      if (directory !== config.dataRoot && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      // Filesystem errors contain private paths, including owner/session names.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        'The storage tree (DATA_DIR) contains a directory this process cannot read, write, ' +
          'or traverse. Check the permissions of its existing sub-folders. If DATA_DIR is the ' +
          'top level of a mounted disk, use a dedicated sub-folder instead.',
      );
    }
  }
}

export function buildStorageProvider(config: StorageRuntimeConfig): StorageProvider {
  if (config.provider === 's3') return s3StorageProvider(config);
  return localFsStorageProvider({
    dataRoot: config.dataRoot,
    ...(config.readUrlBase ? { readUrlBase: config.readUrlBase } : {}),
  });
}
