// Provider access for the web process. Server-only: every route/server component
// resolves the active provider for a type through these helpers (the registry +
// env/DB-resolved config), never by importing a concrete vendor adapter.

import { createHash } from 'node:crypto';
import {
  assembleLlmRuntimeConfig,
  buildLlmProvider,
  buildMusicProvider,
  musicProviderSelection,
  musicTracksPerRequest,
  type LlmProvider,
  type MusicProvider,
} from '@liedmotif/providers';
import { smtpEmailSender, type EmailSender } from '@liedmotif/providers/email';
import {
  buildStorageProvider,
  resolveStorageRuntimeConfig,
  type StorageProvider,
} from '@liedmotif/storage';
import { resolveLlmRuntimeConfig, resolveMusicRuntimeConfig } from '@liedmotif/db';
import { getDb } from '@/lib/db';
import { encryptionKeyIfConfigured } from '@/lib/providers/credentials';
import { accountEmailConfig } from '../env';

// Providers are stateless adapters, yet several run per request (headroom gate,
// audio route). Cache the instance keyed by a digest of its resolved config — a
// config change still yields a fresh, correct adapter.
let cachedMusic: { key: string; provider: MusicProvider } | null = null;
let cachedStorage: { key: string; provider: StorageProvider } | null = null;
let cachedLlm: { key: string; provider: LlmProvider } | null = null;

/**
 * The active music provider — `mock` by default, or the real Suno adapter when
 * `MUSIC_PROVIDER=suno`, its credential resolved per call by the resolver the
 * worker shares (env first, then the key saved in onboarding or Settings).
 * Rejects with a sanitized `ProviderConfigError` while the selected provider has
 * no key anywhere. Server-only: the resolved secret never leaves this process.
 */
export async function getMusicProvider(): Promise<MusicProvider> {
  const selection = musicProviderSelection(process.env.MUSIC_PROVIDER);
  const config =
    selection === 'mock'
      ? {}
      : await resolveMusicRuntimeConfig(getDb(), {
          providerKey: selection,
          encryptionKey: encryptionKeyIfConfigured(),
        });
  const key = createHash('sha256')
    .update(JSON.stringify([selection, config]))
    .digest('hex');
  if (cachedMusic?.key !== key) {
    cachedMusic = { key, provider: buildMusicProvider(selection, config) };
  }
  return cachedMusic.provider;
}

/** Tracks per provider call, for showing call-counted limits as Tracks. Display
 *  only, so an unknown `MUSIC_PROVIDER` (the worker refuses it) falls back to 2. */
export function getTypicalTracksPerMusicRequest(): number {
  try {
    return musicTracksPerRequest(musicProviderSelection(process.env.MUSIC_PROVIDER));
  } catch {
    return 2;
  }
}

/** The active storage provider — `local-fs` under `DATA_DIR` by default, or an
 * S3-compatible bucket when `STORAGE_PROVIDER=s3` (`S3_*` env vars). The cache
 * key is a digest, not the config itself: the S3 config carries the secret
 * access key, which must never sit in a loggable string. */
export function getStorageProvider(): StorageProvider {
  const config = resolveStorageRuntimeConfig();
  const key = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  if (cachedStorage?.key !== key) {
    cachedStorage = { key, provider: buildStorageProvider(config) };
  }
  return cachedStorage.provider;
}

/**
 * The configured text LLM with its credential AND runtime settings resolved
 * (env -> DB, per field), or `null` when none is configured — the text LLM is
 * optional. The model/base URL stored on the credential row by the
 * setup wizard / settings page count exactly like their `LLM_*` env
 * counterparts, with env winning where both are set. Server-only: the resolved
 * secret never leaves this process.
 */
export async function getLlmProvider(): Promise<LlmProvider | null> {
  const resolved = await resolveLlmRuntimeConfig(getDb(), {
    encryptionKey: encryptionKeyIfConfigured(),
  });
  if (!resolved) return null;
  const config = assembleLlmRuntimeConfig(resolved);
  // Same memo shape as music/storage, keyed on the RESOLVED config so a
  // credential/settings change still yields a fresh adapter on its next
  // resolution. A digest, not the config itself — it carries the secret.
  const key = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  if (cachedLlm?.key === key) return cachedLlm.provider;
  const provider = buildLlmProvider(config);
  cachedLlm = provider ? { key, provider } : null;
  return provider;
}

/**
 * The account-email sender, built from `SMTP_URL` + `MAIL_FROM` on each call, so
 * nothing mail-related is read until a mail is sent and `next build` needs no
 * SMTP. Callers gate on `isAccountEmailEnabled()` first; with account email off
 * there is no sender to build and this throws.
 */
export function getEmailSender(): EmailSender {
  const config = accountEmailConfig();
  if (!config) throw new Error('account email is off: set both SMTP_URL and MAIL_FROM');
  return smtpEmailSender(config);
}
