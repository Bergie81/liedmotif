// Provider-credential repository: the DB-backed side of credential resolution.
//
// Credentials are instance-owned (`owner_user_id IS NULL`) and admin-only.
// Secrets are written ONLY as AES-256-GCM envelopes (`crypto.ts`); the plaintext
// never lands in a column and never leaves the server un-masked. Two read paths,
// deliberately separated:
//   - `getCredentialStatus` / `listCredentialStatuses` — UI-facing: configured?,
//     source (`env`/`database`), and a MASKED preview. Never the raw secret.
//   - `resolveProviderCredential` and the per-kind runtime resolvers built on it —
//     server-only: which provider, its decrypted secret and its settings for an
//     actual provider call (worker / API route), env-first then DB.

import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import type { Database } from '../client';
import type { DbOrTx } from '../transactions';
import { providerCredentials } from '../schema';
import type { EncryptedSecret, ProviderConfig } from '../schema/types';
import { decryptSecret, encryptSecret } from './crypto';
import { maskSecret } from './masking';
import {
  parseTimeoutMs,
  readEnvLayer,
  resolveCredentialSource,
  resolveLlmRuntimeSettings,
  resolveProviderSettings,
  selectProviderKey,
  textLlmKeyShareable,
  type CredentialProviderType,
  type CredentialSource,
  type ImageRuntimeSettings,
  type LlmRuntimeSettings,
  type MusicRuntimeSettings,
} from './resolution';

/** Identifies one credential requirement: a provider kind plus its open-vocab key. */
export interface CredentialRef {
  providerType: CredentialProviderType;
  providerKey: string;
}

/** UI-facing credential status — masked preview only, never the raw secret. */
export interface CredentialStatus extends CredentialRef {
  /** The stored row's name, or `null` when no row is stored (an env-only provider). */
  displayName: string | null;
  /** True when a secret resolves: env, the database, or a shared text LLM key. */
  configured: boolean;
  /** Which source won, or `null` when unconfigured. */
  source: CredentialSource | null;
  /** Masked preview of the resolved secret (last 4), or `null` when unconfigured. */
  masked: string | null;
  /** Non-secret provider config stored in the DB (base URL, model, …). */
  config: ProviderConfig | null;
  lastValidatedAt: Date | null;
  validationStatus: string | null;
  /**
   * True when a DB-stored secret exists but could not be decrypted (e.g. the
   * encryption key was rotated). The status still resolves (so settings pages
   * render); the preview is just unavailable until the secret is re-entered.
   */
  decryptError: boolean;
}

/**
 * Inputs for the resolvers. `encryptionKey` is optional: it is only needed to
 * decrypt a DB-stored secret, so an env-only instance (or an unconfigured
 * credential) resolves without it. Decrypting a stored secret without a key throws.
 */
interface WithEnvAndKey {
  env?: NodeJS.ProcessEnv;
  encryptionKey?: Buffer;
}

/** Decrypt a stored envelope, requiring the key to be present. */
function decryptStored(secret: EncryptedSecret, key: Buffer | undefined): string {
  if (!key) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY is required to read a DB-stored secret');
  }
  return decryptSecret(secret, key);
}

/** Matches the single instance-level (owner-less) credential for a requirement. */
function instanceCredentialFilter(ref: CredentialRef) {
  return and(
    isNull(providerCredentials.ownerUserId),
    eq(providerCredentials.providerType, ref.providerType),
    eq(providerCredentials.providerKey, ref.providerKey),
  );
}

/** Load the single instance-level (owner-less) credential row for a requirement. */
async function getStoredCredential(db: DbOrTx, ref: CredentialRef) {
  const rows = await db
    .select()
    .from(providerCredentials)
    .where(instanceCredentialFilter(ref))
    .limit(1);
  return rows[0];
}

export interface UpsertCredentialInput extends CredentialRef {
  displayName: string;
  /**
   * Plaintext secret to seal. `null` removes the stored secret (an image
   * credential that shares the text LLM key); omit to keep it.
   */
  secret?: string | null;
  config?: ProviderConfig | null;
  /** Required when `secret` is provided (used to encrypt it). */
  encryptionKey?: Buffer;
}

/**
 * Insert or update the instance-level credential for a requirement, encrypting the
 * secret when one is supplied. Idempotent per `(providerType, providerKey)`: a
 * re-save updates the existing row in place rather than duplicating it. Always
 * marks the stored source as `database`.
 *
 * Single-LLM invariant: the instance runs at most ONE text LLM, so
 * saving an `llm` credential for a different provider REPLACES the previous LLM
 * row instead of accumulating one row per provider key — "which LLM is
 * configured" stays a single-row question. The replace runs in one transaction
 * (a failed write can't leave the instance with no LLM row), and the partial
 * unique index `provider_credentials_instance_llm_singleton` backstops it at the
 * database boundary: a racing save loses with a unique violation instead of
 * persisting a second LLM row.
 */
export async function upsertProviderCredential(
  db: Database,
  input: UpsertCredentialInput,
): Promise<void> {
  let encryptedSecret: EncryptedSecret | null | undefined =
    input.secret === null ? null : undefined;
  if (typeof input.secret === 'string') {
    if (!input.encryptionKey) {
      throw new Error('encryptionKey is required to store a provider secret');
    }
    encryptedSecret = encryptSecret(input.secret, input.encryptionKey);
  }

  await db.transaction(async (tx) => {
    if (input.providerType === 'llm') {
      await tx
        .delete(providerCredentials)
        .where(
          and(
            isNull(providerCredentials.ownerUserId),
            eq(providerCredentials.providerType, 'llm'),
            ne(providerCredentials.providerKey, input.providerKey),
          ),
        );
    }

    const existing = await getStoredCredential(tx, input);
    if (existing) {
      await tx
        .update(providerCredentials)
        .set({
          displayName: input.displayName,
          // Only overwrite the stored secret when a new one (or its removal) was given.
          ...(encryptedSecret !== undefined ? { encryptedSecret } : {}),
          ...(input.config !== undefined ? { config: input.config } : {}),
          source: 'database',
        })
        .where(eq(providerCredentials.id, existing.id));
      return;
    }

    await tx.insert(providerCredentials).values({
      providerType: input.providerType,
      providerKey: input.providerKey,
      displayName: input.displayName,
      encryptedSecret: encryptedSecret ?? null,
      config: input.config ?? null,
      source: 'database',
    });
  });
}

/** Delete one exact instance-level stored credential without affecting env configuration. */
export async function deleteProviderCredential(db: Database, ref: CredentialRef): Promise<boolean> {
  const deleted = await db
    .delete(providerCredentials)
    .where(instanceCredentialFilter(ref))
    .returning({ id: providerCredentials.id });
  return deleted.length > 0;
}

/** Record a sanitized validation outcome for a credential (status text only). */
export async function setCredentialValidation(
  db: Database,
  input: CredentialRef & { status: string; at?: Date },
): Promise<void> {
  await db
    .update(providerCredentials)
    .set({ validationStatus: input.status, lastValidatedAt: input.at ?? new Date() })
    .where(instanceCredentialFilter(input));
}

/**
 * Resolve a credential to its UI-facing status (env-first, DB fills gaps; an
 * image provider without a key of its own reports the text LLM key it shares).
 * The masked preview comes from the resolved key — and the raw secret is never
 * part of the returned object.
 */
export async function getCredentialStatus(
  db: Database,
  ref: CredentialRef & WithEnvAndKey,
): Promise<CredentialStatus> {
  const env = ref.env ?? process.env;
  const envSecret = readEnvLayer(ref.providerType, ref.providerKey, env).apiKey;
  const stored = await getStoredCredential(db, ref);
  const hasDbSecret = Boolean(stored?.encryptedSecret);
  let source = resolveCredentialSource(envSecret, hasDbSecret);
  let masked: string | null = null;
  let decryptError = false;
  if (source === null && ref.providerType === 'image') {
    let sharedKey: string | undefined;
    try {
      sharedKey = await resolveSharedImageKey(db, ref.providerKey, {
        env,
        encryptionKey: ref.encryptionKey,
      });
    } catch {
      // An undecryptable text LLM key shares nothing; the text LLM's own status
      // reports the decrypt error.
    }
    if (sharedKey) {
      source = 'shared';
      masked = maskSecret(sharedKey);
    }
  }
  if (source === 'env' && envSecret) {
    masked = maskSecret(envSecret);
  } else if (source === 'database' && stored?.encryptedSecret) {
    try {
      masked = maskSecret(decryptStored(stored.encryptedSecret, ref.encryptionKey));
    } catch {
      // A rotated/invalid key (or missing key) must not crash the settings page —
      // degrade to "configured, preview unavailable" so the admin can re-enter it.
      decryptError = true;
    }
  }

  return {
    providerType: ref.providerType,
    providerKey: ref.providerKey,
    displayName: stored?.displayName ?? null,
    configured: source !== null,
    source,
    masked,
    config: (stored?.config as ProviderConfig | null) ?? null,
    lastValidatedAt: stored?.lastValidatedAt ?? null,
    validationStatus: stored?.validationStatus ?? null,
    decryptError,
  };
}

/** Resolve every requirement's UI status in one call. */
export async function listCredentialStatuses(
  db: Database,
  refs: readonly CredentialRef[],
  options: WithEnvAndKey,
): Promise<CredentialStatus[]> {
  return Promise.all(
    refs.map((ref) =>
      getCredentialStatus(db, { ...ref, env: options.env, encryptionKey: options.encryptionKey }),
    ),
  );
}

/**
 * The non-secret `config` blob stored on a credential row (base URL, model, …),
 * or `null` when the row is absent or carries no config.
 */
export async function getStoredProviderConfig(
  db: Database,
  ref: CredentialRef,
): Promise<ProviderConfig | null> {
  const stored = await getStoredCredential(db, ref);
  return (stored?.config as ProviderConfig | null) ?? null;
}

/**
 * The provider key of the most recently saved instance-level row of a kind, or
 * `null` when none is stored — the stored half of `selectProviderKey`. The upsert
 * keeps a single instance LLM row; the ordering makes the latest one win
 * deterministically should a pre-invariant database still hold duplicates.
 */
export async function getStoredProviderKey(
  db: Database,
  providerType: CredentialProviderType,
): Promise<string | null> {
  const rows = await db
    .select({ providerKey: providerCredentials.providerKey })
    .from(providerCredentials)
    .where(
      and(
        isNull(providerCredentials.ownerUserId),
        eq(providerCredentials.providerType, providerType),
      ),
    )
    .orderBy(desc(providerCredentials.updatedAt))
    .limit(1);
  return rows[0]?.providerKey ?? null;
}

/**
 * When the stored instance-level credential for a requirement last changed, or
 * `null` when no row is stored. It tracks app saves only: a row also exists as
 * the fallback beside an env-supplied key or base URL, and an env change (which
 * takes a process restart) never moves this stamp, so a caller judging whether
 * the effective config changed must account for the env layer itself.
 */
export async function getCredentialUpdatedAt(db: DbOrTx, ref: CredentialRef): Promise<Date | null> {
  const [row] = await db
    .select({ updatedAt: providerCredentials.updatedAt })
    .from(providerCredentials)
    .where(instanceCredentialFilter(ref))
    .limit(1);
  return row?.updatedAt ?? null;
}

/** A resolved provider: which one, its stored config, and a reader for its secret. */
export interface ResolvedCredential {
  providerKey: string;
  /** The stored row's non-secret config; `null` when nothing is stored. */
  config: ProviderConfig | null;
  /**
   * The raw secret: the env key when the env layer supplies one, else the stored
   * envelope decrypted with `encryptionKey`. Throws when a stored secret cannot be
   * decrypted. Never serialize the result to the client or a log.
   */
  readApiKey(encryptionKey: Buffer | undefined): string | undefined;
}

/**
 * Server-only: resolve a provider credential env-first, the stored row filling
 * the gaps. Without a `providerKey` the provider is selected too
 * (`selectProviderKey`), and `null` means none is configured. Nothing is
 * decrypted until `readApiKey` is called, so a caller that needs only the
 * settings never touches the secret.
 */
export async function resolveProviderCredential(
  db: Database,
  ref: { providerType: CredentialProviderType; providerKey?: string; env?: NodeJS.ProcessEnv },
): Promise<ResolvedCredential | null> {
  const env = ref.env ?? process.env;
  const providerKey =
    ref.providerKey ??
    selectProviderKey(ref.providerType, env, await getStoredProviderKey(db, ref.providerType));
  if (!providerKey) return null;
  const stored = await getStoredCredential(db, { providerType: ref.providerType, providerKey });
  const envApiKey = readEnvLayer(ref.providerType, providerKey, env).apiKey;
  return {
    providerKey,
    config: (stored?.config as ProviderConfig | null) ?? null,
    readApiKey: (encryptionKey) =>
      envApiKey ??
      (stored?.encryptedSecret ? decryptStored(stored.encryptedSecret, encryptionKey) : undefined),
  };
}

/**
 * Server-only: the music model's runtime config for an actual provider call, the
 * one resolution web and worker share. The API key and base URL resolve like
 * every saved field; `SUNO_MODEL` / `SUNO_CALLBACK_URL` are env-only. Callers
 * resolve it per use, so a key saved in the app applies without a restart.
 * Carries the raw secret: never serialize it to the client or a log.
 */
export async function resolveMusicRuntimeConfig(
  db: Database,
  ref: { providerKey: string } & WithEnvAndKey,
): Promise<MusicRuntimeSettings> {
  const env = ref.env ?? process.env;
  const credential = await resolveProviderCredential(db, {
    providerType: 'music',
    providerKey: ref.providerKey,
    env,
  });
  const apiKey = credential?.readApiKey(ref.encryptionKey);
  const { baseUrl } = resolveProviderSettings('music', ref.providerKey, credential?.config, env);
  const model = env.SUNO_MODEL?.trim();
  const callbackUrl = env.SUNO_CALLBACK_URL?.trim();
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
    ...(callbackUrl ? { callbackUrl } : {}),
  };
}

/**
 * Server-only: the text LLM's provider, secret and runtime settings for an actual
 * provider call, the one resolution web and worker share, or `null` when no LLM
 * is configured — the text LLM is optional. Carries the raw secret:
 * never serialize it to the client or a log.
 */
export async function resolveLlmRuntimeConfig(
  db: Database,
  ref: WithEnvAndKey = {},
): Promise<{ providerKey: string; apiKey: string | null; settings: LlmRuntimeSettings } | null> {
  const env = ref.env ?? process.env;
  const credential = await resolveProviderCredential(db, { providerType: 'llm', env });
  if (!credential) return null;
  const { providerKey, config } = credential;
  return {
    providerKey,
    apiKey: credential.readApiKey(ref.encryptionKey) ?? null,
    settings: resolveLlmRuntimeSettings({ providerKey, storedConfig: config, env }),
  };
}

/**
 * Server-only: the text LLM key an image provider of `vendor` without a key of
 * its own uses, or `null` when the resolved text LLM's key cannot be shared
 * (`textLlmKeyShareable`) or there is none. The key is referenced, never copied:
 * rotating or removing it on the text LLM moves Cover images with it. Throws when
 * a stored text LLM secret cannot be decrypted. Never serialize the key to the
 * client or a log.
 */
export async function resolveShareableTextLlmKey(
  db: Database,
  ref: WithEnvAndKey = {},
): Promise<{ vendor: string; apiKey: string } | null> {
  const env = ref.env ?? process.env;
  const llm = await resolveProviderCredential(db, { providerType: 'llm', env });
  if (!llm) return null;
  const { baseUrl } = resolveProviderSettings('llm', llm.providerKey, llm.config, env);
  if (!textLlmKeyShareable({ providerKey: llm.providerKey, baseUrl })) return null;
  const apiKey = llm.readApiKey(ref.encryptionKey);
  return apiKey ? { vendor: llm.providerKey, apiKey } : null;
}

/**
 * Server-only: the text LLM key an image provider of `providerKey` uses when it
 * has none of its own (`resolveShareableTextLlmKey` matched to the vendor), else
 * `undefined`. Throws like it. Never serialize the key to the client or a log.
 */
export async function resolveSharedImageKey(
  db: Database,
  providerKey: string,
  ref: WithEnvAndKey,
): Promise<string | undefined> {
  const shared = await resolveShareableTextLlmKey(db, ref);
  return shared?.vendor === providerKey ? shared.apiKey : undefined;
}

/**
 * Server-only: the generated-cover provider's runtime config for an actual
 * provider call, the one resolution web and worker share, or `null` when no image
 * provider is selected. The provider, key and model resolve like every saved
 * field; the other `IMAGE_*` settings are env-only. Callers resolve it per use,
 * so a key or model saved in the app applies to the next cover without a
 * restart. Without a key of its own the provider uses the text LLM's key of the
 * same vendor (`resolveShareableTextLlmKey`). A selected provider without any key
 * still resolves — building it then yields no provider. Carries the raw secret:
 * never serialize it to the client or a log.
 */
export async function resolveImageRuntimeConfig(
  db: Database,
  ref: WithEnvAndKey = {},
): Promise<ImageRuntimeSettings | null> {
  const env = ref.env ?? process.env;
  const credential = await resolveProviderCredential(db, { providerType: 'image', env });
  if (!credential) return null;
  const { providerKey } = credential;
  const apiKey =
    credential.readApiKey(ref.encryptionKey) ??
    (await resolveSharedImageKey(db, providerKey, { env, encryptionKey: ref.encryptionKey }));
  const { model } = resolveProviderSettings('image', providerKey, credential.config, env);
  const resolution = env.IMAGE_RESOLUTION?.trim();
  const aspectRatio = env.IMAGE_ASPECT_RATIO?.trim();
  const supportedParams = env.IMAGE_SUPPORTED_PARAMS?.trim();
  const timeoutMs = parseTimeoutMs(env.IMAGE_REQUEST_TIMEOUT_MS);
  return {
    providerKey,
    ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}),
    ...(resolution ? { resolution } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(timeoutMs ? { requestTimeoutMs: timeoutMs } : {}),
    ...(supportedParams ? { supportedParams } : {}),
  };
}
