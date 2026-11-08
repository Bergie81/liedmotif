import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertStorageRootWritable,
  buildStorageProvider,
  resolveStorageRuntimeConfig,
} from './build';
import { StorageKeyError } from './safe-key';

// The construction seam: env → discriminated config → adapter. `local-fs` is
// the default (existing installs keep working untouched); selecting `s3` with
// required settings missing must fail fast at boot, and blank env values count
// as unset so templated env files with empty defaults still parse.

const S3_ENV = {
  STORAGE_PROVIDER: 's3',
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'liedmotif',
  S3_ACCESS_KEY_ID: 'access-key',
  S3_SECRET_ACCESS_KEY: 'secret-key',
} as const;

describe('resolveStorageRuntimeConfig', () => {
  it('defaults to local-fs under /data when nothing is configured', () => {
    expect(resolveStorageRuntimeConfig({})).toEqual({ provider: 'local-fs', dataRoot: '/data' });
  });

  it('treats a blank provider selection as unset and honors DATA_DIR', () => {
    const config = resolveStorageRuntimeConfig({
      STORAGE_PROVIDER: '  ',
      DATA_DIR: ' /srv/liedmotif ',
    });
    expect(config).toEqual({ provider: 'local-fs', dataRoot: '/srv/liedmotif' });
  });

  it('ignores S3 variables entirely when local-fs is selected', () => {
    const config = resolveStorageRuntimeConfig({ ...S3_ENV, STORAGE_PROVIDER: 'local-fs' });
    expect(config).toEqual({ provider: 'local-fs', dataRoot: '/data' });
  });

  it('rejects an unknown provider selection', () => {
    expect(() => resolveStorageRuntimeConfig({ STORAGE_PROVIDER: 'gcs' })).toThrow(
      /STORAGE_PROVIDER/,
    );
  });

  it('resolves a full S3 selection', () => {
    expect(resolveStorageRuntimeConfig({ ...S3_ENV })).toEqual({
      provider: 's3',
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      bucket: 'liedmotif',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      forcePathStyle: false,
    });
  });

  it('leaves the endpoint unset for AWS itself', () => {
    const env = { ...S3_ENV } as Record<string, string>;
    delete env.S3_ENDPOINT;
    expect(resolveStorageRuntimeConfig(env)).not.toHaveProperty('endpoint');
  });

  it.each(['S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'])(
    'fails fast when %s is missing, naming the variable but not any secret value',
    (name) => {
      const env = { ...S3_ENV } as Record<string, string>;
      delete env[name];
      let thrown: Error | undefined;
      try {
        resolveStorageRuntimeConfig(env);
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown?.message).toContain(name);
      expect(thrown?.message).not.toContain('secret-key');
    },
  );

  it('treats blank S3 values as unset', () => {
    expect(() => resolveStorageRuntimeConfig({ ...S3_ENV, S3_BUCKET: '   ' })).toThrow(/S3_BUCKET/);
  });

  it('lists every missing required variable at once', () => {
    let thrown: Error | undefined;
    try {
      resolveStorageRuntimeConfig({ STORAGE_PROVIDER: 's3' });
    } catch (err) {
      thrown = err as Error;
    }
    for (const name of ['S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
      expect(thrown?.message).toContain(name);
    }
  });

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['', false],
  ])('parses S3_FORCE_PATH_STYLE=%j as %j', (raw, expected) => {
    const config = resolveStorageRuntimeConfig({ ...S3_ENV, S3_FORCE_PATH_STYLE: raw });
    expect(config).toMatchObject({ forcePathStyle: expected });
  });

  it('normalizes the optional key prefix and rejects an unsafe one', () => {
    expect(
      resolveStorageRuntimeConfig({ ...S3_ENV, S3_KEY_PREFIX: ' liedmotif/prod/ ' }),
    ).toMatchObject({ keyPrefix: 'liedmotif/prod' });
    expect(resolveStorageRuntimeConfig({ ...S3_ENV, S3_KEY_PREFIX: '  ' })).not.toHaveProperty(
      'keyPrefix',
    );
    expect(() => resolveStorageRuntimeConfig({ ...S3_ENV, S3_KEY_PREFIX: '../escape' })).toThrow(
      StorageKeyError,
    );
  });
});

describe('DATA_DIR validation', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liedmotif-data-root-'));
    roots.push(root);
    return root;
  }

  it('refuses a relative DATA_DIR without echoing the configured path', () => {
    // A relative root resolves against `process.cwd()`, which differs between
    // dev, the standalone server and the worker: writes land under one tree
    // while deletes no-op against another and report success.
    const resolve = () => resolveStorageRuntimeConfig({ DATA_DIR: 'var/liedmotif-library' });
    expect(resolve).toThrow(/DATA_DIR/);
    // The variable name is what the operator needs; a boot log is the wrong
    // place to publish the host's directory layout.
    expect(resolve).not.toThrow(/var\/liedmotif-library/);
  });

  it('accepts an existing writable root', async () => {
    const dataRoot = await tempRoot();
    await expect(
      assertStorageRootWritable({ provider: 'local-fs', dataRoot }),
    ).resolves.toBeUndefined();
  });

  it('refuses a root that does not exist', async () => {
    const dataRoot = path.join(await tempRoot(), 'not-created');
    await expect(assertStorageRootWritable({ provider: 'local-fs', dataRoot })).rejects.toThrow(
      /DATA_DIR/,
    );
  });

  // Root ignores the permission bits, so this can only be proven as a normal user.
  it.skipIf(process.getuid?.() === 0)(
    'refuses a root the runtime user cannot write (a mis-chowned volume)',
    async () => {
      const dataRoot = await tempRoot();
      await chmod(dataRoot, 0o500);
      try {
        await expect(assertStorageRootWritable({ provider: 'local-fs', dataRoot })).rejects.toThrow(
          /DATA_DIR/,
        );
      } finally {
        await chmod(dataRoot, 0o700);
      }
    },
  );

  it('has nothing to check for an S3 backend', async () => {
    await expect(
      assertStorageRootWritable(resolveStorageRuntimeConfig({ ...S3_ENV })),
    ).resolves.toBeUndefined();
  });

  it.skipIf(process.getuid?.() === 0)(
    'refuses unwritable member folders even when the storage root is writable',
    async () => {
      const dataRoot = await tempRoot();
      const memberFolder = path.join(dataRoot, 'covers/generated/member-private-id');
      await mkdir(memberFolder, { recursive: true });
      await chmod(memberFolder, 0o555);
      try {
        await expect(assertStorageRootWritable({ dataRoot })).rejects.toThrow(
          'The storage tree (DATA_DIR) contains a directory this process cannot read, write, or traverse',
        );
      } finally {
        await chmod(memberFolder, 0o700);
      }
    },
  );

  it('accepts nested media directories without following directory symlinks', async () => {
    const dataRoot = await tempRoot();
    const outside = await tempRoot();
    const sessionFolder = path.join(dataRoot, 'tracks/member/session');
    await mkdir(sessionFolder, { recursive: true });
    await writeFile(path.join(sessionFolder, 'track.mp3'), 'audio');
    await symlink(outside, path.join(dataRoot, 'external'));
    await chmod(outside, 0o000);
    try {
      await expect(assertStorageRootWritable({ dataRoot })).resolves.toBeUndefined();
    } finally {
      await chmod(outside, 0o700);
    }
  });
});

describe('buildStorageProvider', () => {
  it('builds the local-fs adapter by default', () => {
    expect(buildStorageProvider({ dataRoot: '/tmp/x' }).providerKey).toBe('local-fs');
  });

  it('builds the S3 adapter from a resolved S3 config', () => {
    const provider = buildStorageProvider(resolveStorageRuntimeConfig({ ...S3_ENV }));
    expect(provider.providerKey).toBe('s3');
  });
});
