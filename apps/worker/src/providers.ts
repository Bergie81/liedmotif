// Provider access for the worker process. Like the web side, the worker resolves
// the active provider for each type through the registry/builders (never a concrete
// vendor), so the job loop can submit/poll/download without importing
// Suno or a vendor SDK directly.

import { createHash } from 'node:crypto';
import {
  assembleLlmRuntimeConfig,
  buildGeneratedImageProvider,
  buildLlmProvider,
  buildMusicProvider,
  buildSunoCoverImageProvider,
  imageProviderSelection,
  musicProviderSelection,
  type GeneratedImageProvider,
  type LlmProvider,
  type MusicProvider,
  type MusicProviderSelection,
} from '@liedmotif/providers';
import {
  loadEncryptionKey,
  resolveImageRuntimeConfig,
  resolveLlmRuntimeConfig,
  resolveMusicRuntimeConfig,
  type Database,
} from '@liedmotif/db';
import {
  buildStorageProvider,
  resolveStorageRuntimeConfig,
  type StorageProvider,
} from '@liedmotif/storage';

export interface WorkerProviders {
  /**
   * The selected music provider (`MUSIC_PROVIDER`). Only the selection is fixed at
   * boot: its credential can be saved in the app at any time, so the provider
   * itself is built per use by `createWorkerMusicResolver`.
   */
  musicSelection: MusicProviderSelection;
  storage: StorageProvider;
}

/**
 * Resolve the AES-256-GCM master key for provider-URL encryption. An
 * ABSENT `CREDENTIAL_ENCRYPTION_KEY` returns null — the worker still boots and runs
 * its non-pipeline jobs; the pipeline tasks then fail loudly at run time rather than
 * storing a provider URL in the clear. A PRESENT-but-invalid key throws (fail fast).
 */
export function resolveWorkerEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  if (!env.CREDENTIAL_ENCRYPTION_KEY) return null;
  return loadEncryptionKey(env);
}

export function buildWorkerProviders(env: NodeJS.ProcessEnv = process.env): WorkerProviders {
  // Only a typo'd IMAGE_PROVIDER fails the boot: generated covers are optional,
  // and their key can be saved in the app at any time (`createWorkerCoverArtResolver`).
  imageProviderSelection(env.IMAGE_PROVIDER);
  return {
    musicSelection: musicProviderSelection(env.MUSIC_PROVIDER),
    storage: buildStorageProvider(resolveStorageRuntimeConfig(env)),
  };
}

export interface WorkerMusicResolver {
  /**
   * The selected music provider with its credential resolved now — env first, then
   * the key saved in the app — reusing the built adapter until the resolved config
   * changes. Rejects with a sanitized `ProviderConfigError` while no key exists, so
   * a music job fails loudly, as a retried Graphile error, rather than spending.
   */
  getMusic(): Promise<MusicProvider>;
  /**
   * The music-task-driven Suno cover source, or `null` unless Suno is selected and
   * has a key. Whether it actually runs is decided per attempt by
   * `resolveSessionCoverImageProvider`.
   */
  getSunoCoverArt(): Promise<GeneratedImageProvider | null>;
}

export interface WorkerMusicResolverDeps {
  db: Database;
  /** `null` still resolves an env key; only a stored key then fails to decrypt. */
  encryptionKey: Buffer | null;
  selection: MusicProviderSelection;
  env?: NodeJS.ProcessEnv;
  /** The DB read, injectable in tests; production uses the shared `@liedmotif/db` resolver. */
  readConfig?: typeof resolveMusicRuntimeConfig;
}

export function createWorkerMusicResolver(deps: WorkerMusicResolverDeps): WorkerMusicResolver {
  const env = deps.env ?? process.env;
  const readConfig = deps.readConfig ?? resolveMusicRuntimeConfig;
  // Memoized on a digest of the resolved config, which carries the secret.
  let music: { key: string; provider: MusicProvider } | null = null;
  let sunoCover: { key: string; provider: GeneratedImageProvider | null } | null = null;
  async function resolveConfig() {
    const config =
      deps.selection === 'mock'
        ? {}
        : await readConfig(deps.db, {
            providerKey: deps.selection,
            env,
            ...(deps.encryptionKey ? { encryptionKey: deps.encryptionKey } : {}),
          });
    return { config, key: createHash('sha256').update(JSON.stringify(config)).digest('hex') };
  }
  return {
    async getMusic() {
      const { config, key } = await resolveConfig();
      if (music?.key !== key) music = { key, provider: buildMusicProvider(deps.selection, config) };
      return music.provider;
    },
    async getSunoCoverArt() {
      if (deps.selection !== 'suno') return null;
      const { config, key } = await resolveConfig();
      if (sunoCover?.key !== key) {
        sunoCover = { key, provider: buildSunoCoverImageProvider(config) };
      }
      return sunoCover.provider;
    },
  };
}

export interface WorkerCoverArtResolver {
  /**
   * The prompt-driven generated-cover provider with its key resolved now — env
   * first, then the key saved in the app — or `null` while none resolves:
   * generated covers are optional and cosmetic, so a missing key means "no
   * generated covers". Reuses the built adapter, and the model capabilities it
   * caches, until the resolved config changes.
   */
  getCoverArt(): Promise<GeneratedImageProvider | null>;
}

export interface WorkerCoverArtResolverDeps {
  db: Database;
  /** `null` still resolves an env key; only a stored key then fails to decrypt. */
  encryptionKey: Buffer | null;
  env?: NodeJS.ProcessEnv;
  /** The DB read, injectable in tests; production uses the shared `@liedmotif/db` resolver. */
  readConfig?: typeof resolveImageRuntimeConfig;
}

export function createWorkerCoverArtResolver(
  deps: WorkerCoverArtResolverDeps,
): WorkerCoverArtResolver {
  const env = deps.env ?? process.env;
  const readConfig = deps.readConfig ?? resolveImageRuntimeConfig;
  // Memoized on a digest of the resolved config, which carries the secret.
  let cached: { key: string; provider: GeneratedImageProvider | null } | null = null;
  return {
    async getCoverArt() {
      const config = await readConfig(deps.db, {
        env,
        ...(deps.encryptionKey ? { encryptionKey: deps.encryptionKey } : {}),
      });
      const key = createHash('sha256').update(JSON.stringify(config)).digest('hex');
      if (cached?.key !== key) cached = { key, provider: buildGeneratedImageProvider(config) };
      return cached.provider;
    },
  };
}

export interface WorkerLlmResolver {
  /**
   * The configured text LLM with credential AND runtime settings resolved
   * (env -> DB, per field — the same resolver the web side uses), or
   * `null` when unconfigured: the text LLM is optional and the
   * worker runs without it. Re-reads config each call but reuses the built
   * adapter until the RESOLVED config changes.
   */
  getLlm(): Promise<LlmProvider | null>;
  /** Non-secret boot-log summary: the last-resolved provider key, or `none`. */
  resolvedLlmKey(): string;
}

export interface WorkerLlmResolverDeps {
  db: Database;
  /**
   * `null` degrades to env-only secrets (same contract as the web's
   * `encryptionKeyIfConfigured`): the worker still boots and resolves an
   * env-configured LLM; only reading a DB-stored envelope fails at call time.
   */
  encryptionKey: Buffer | null;
  env?: NodeJS.ProcessEnv;
  /** The DB read, injectable in tests; production uses the shared `@liedmotif/db` resolver. */
  readConfig?: typeof resolveLlmRuntimeConfig;
}

export function createWorkerLlmResolver(deps: WorkerLlmResolverDeps): WorkerLlmResolver {
  const env = deps.env ?? process.env;
  const readConfig = deps.readConfig ?? resolveLlmRuntimeConfig;
  // Memoized on a sha256 digest of the RESOLVED config — a digest, not the
  // config itself, because it carries the secret and the key must be safe to
  // compare or surface without leaking it.
  let cached: { key: string; provider: LlmProvider } | null = null;
  return {
    async getLlm() {
      const resolved = await readConfig(deps.db, {
        env,
        ...(deps.encryptionKey ? { encryptionKey: deps.encryptionKey } : {}),
      });
      if (!resolved) {
        cached = null;
        return null;
      }
      const config = assembleLlmRuntimeConfig(resolved);
      const key = createHash('sha256').update(JSON.stringify(config)).digest('hex');
      if (cached?.key !== key) {
        const provider = buildLlmProvider(config);
        cached = provider ? { key, provider } : null;
      }
      return cached?.provider ?? null;
    },
    resolvedLlmKey() {
      return cached?.provider.providerKey ?? 'none';
    },
  };
}

export async function prewarmGeneratedImageProvider(
  provider: GeneratedImageProvider | null,
): Promise<boolean> {
  if (!provider) return true;
  try {
    return (await provider.validateCredentials()).ok;
  } catch {
    return false;
  }
}

/**
 * A non-secret capabilities summary, safe to log at boot. The music, cover-image
 * and text LLM credentials are DB-backed and async to resolve, so music reports
 * its selection, cover art is logged once it resolves, and the LLM reports the
 * resolver's cached state — `none` until (or unless) a resolution has produced a
 * provider.
 */
export function describeProviders(
  providers: WorkerProviders,
  llm?: WorkerLlmResolver,
): Record<string, unknown> {
  return {
    music: providers.musicSelection,
    storage: providers.storage.providerKey,
    llm: llm?.resolvedLlmKey() ?? 'none',
  };
}
