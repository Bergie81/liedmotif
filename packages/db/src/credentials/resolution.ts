// Credential resolution: which provider, and where its secret and saved settings come from.
//
// The resolution order is fixed: environment variables
// OVERRIDE or satisfy a required credential, and database-stored credentials fill
// the gaps. The UI surfaces which source won (`env` vs `database`). This module is
// the pure core of that rule — the env-var mapping and the precedence — with no DB
// or crypto dependency, so it is trivially testable; the DB-backed resolver that
// decrypts and masks lives in `repo.ts`.

import { normalizeReasoningEffort, type LlmReasoningEffort } from '@liedmotif/shared';
import type { ProviderConfig } from '../schema/types';

/**
 * Where a resolved provider credential ultimately came from. `shared` is an image
 * provider using the text LLM's key (`textLlmKeyShareable`).
 */
export type CredentialSource = 'env' | 'database' | 'shared';

/** The kind of provider a credential belongs to (mirrors the `provider_type` enum). */
export type CredentialProviderType = 'music' | 'llm' | 'image' | 'storage';

/**
 * Each kind's env counterparts of the fields onboarding and Settings save. Where a
 * kind offers a choice of presets, `providerVar` names the env-configured one and
 * the env key belongs to that provider only — never mis-attributed to a different
 * (e.g. stored) provider, and inert while no provider is named. With
 * `settingsNeedProviderVar` the env base URL and model are scoped the same way;
 * without it they apply to whichever provider either layer selected. Env-only
 * settings (`SUNO_MODEL`, the other `IMAGE_*`, the LLM's tuning) are read by
 * their kind's own resolver.
 */
const ENV_VARS: Partial<
  Record<
    CredentialProviderType,
    {
      providerVar?: string;
      keyVar: string;
      baseUrlVar?: string;
      modelVar?: string;
      settingsNeedProviderVar?: true;
    }
  >
> = {
  music: { keyVar: 'SUNO_API_KEY', baseUrlVar: 'SUNO_BASE_URL' },
  llm: {
    providerVar: 'LLM_PROVIDER',
    keyVar: 'LLM_API_KEY',
    baseUrlVar: 'LLM_BASE_URL',
    modelVar: 'LLM_MODEL',
    settingsNeedProviderVar: true,
  },
  image: { providerVar: 'IMAGE_PROVIDER', keyVar: 'IMAGE_API_KEY', modelVar: 'IMAGE_MODEL' },
};

/** An env value, trimmed; blank/whitespace-only is unset (`SUNO_API_KEY=` configures nothing). */
function readEnvVar(env: NodeJS.ProcessEnv, name: string | undefined): string | undefined {
  return (name && env[name]?.trim()) || undefined;
}

/** A string field of a stored config, trimmed; blank is unset. */
function readStoredField(config: ProviderConfig | null | undefined, field: string) {
  const value = config?.[field];
  return (typeof value === 'string' && value.trim()) || undefined;
}

/** The fields a provider's credential resolves to. Absent fields are omitted. */
export interface ProviderFields {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/** The env layer of one provider's saved fields (see `ENV_VARS` for which apply). */
export function readEnvLayer(
  providerType: CredentialProviderType,
  providerKey: string,
  env: NodeJS.ProcessEnv = process.env,
): ProviderFields {
  const vars = ENV_VARS[providerType];
  if (!vars) return {};
  const named = !vars.providerVar || readEnvVar(env, vars.providerVar) === providerKey;
  const settingsApply = named || !vars.settingsNeedProviderVar;
  const apiKey = named ? readEnvVar(env, vars.keyVar) : undefined;
  const baseUrl = settingsApply ? readEnvVar(env, vars.baseUrlVar) : undefined;
  const model = settingsApply ? readEnvVar(env, vars.modelVar) : undefined;
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
  };
}

/** The env variable behind each field `readEnvLayer` can return for a kind. */
export function envFieldVariables(providerType: CredentialProviderType): {
  [Field in keyof ProviderFields]?: string;
} {
  const vars = ENV_VARS[providerType];
  if (!vars) return {};
  return {
    apiKey: vars.keyVar,
    ...(vars.baseUrlVar ? { baseUrl: vars.baseUrlVar } : {}),
    ...(vars.modelVar ? { model: vars.modelVar } : {}),
  };
}

/**
 * A provider's non-secret saved settings: per field, the env layer wins and the
 * stored config fills the gap. A kind resolves only the fields it saves (no image
 * base URL, no music model).
 */
export function resolveProviderSettings(
  providerType: CredentialProviderType,
  providerKey: string,
  storedConfig: ProviderConfig | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Omit<ProviderFields, 'apiKey'> {
  const vars = ENV_VARS[providerType];
  const fromEnv = readEnvLayer(providerType, providerKey, env);
  const baseUrl = vars?.baseUrlVar
    ? (fromEnv.baseUrl ?? readStoredField(storedConfig, 'baseUrl'))
    : undefined;
  const model = vars?.modelVar
    ? (fromEnv.model ?? readStoredField(storedConfig, 'model'))
    : undefined;
  return { ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}) };
}

/** Vendors whose one API key serves both the text LLM and Cover images. */
const KEY_SHARING_VENDORS: ReadonlySet<string> = new Set(['openai', 'gemini', 'openrouter']);

/**
 * Whether the resolved text LLM's key may serve an image provider of the same
 * vendor that has no key of its own. A base URL override (app or `.env`) means
 * the key belongs to some other endpoint, so it is never sent to the vendor's
 * image API.
 */
export function textLlmKeyShareable(llm: { providerKey: string; baseUrl?: string }): boolean {
  return KEY_SHARING_VENDORS.has(llm.providerKey) && !llm.baseUrl;
}

/**
 * Select the configured provider of a kind with a choice of presets: the env's
 * `providerVar` wins, the stored row's provider fills the gap, else `null`.
 */
export function selectProviderKey(
  providerType: CredentialProviderType,
  env: NodeJS.ProcessEnv,
  storedProviderKey: string | null,
): string | null {
  return readEnvVar(env, ENV_VARS[providerType]?.providerVar) ?? storedProviderKey ?? null;
}

/**
 * The music model's runtime config — structurally the providers package's
 * `MusicRuntimeConfig`, which this package does not depend on. Absent fields are
 * omitted, never present-but-undefined, so a spread cannot shadow a default.
 */
export interface MusicRuntimeSettings {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  callbackUrl?: string;
}

/**
 * The generated-cover provider's runtime config — structurally the providers
 * package's `GeneratedImageRuntimeConfig`, which this package does not depend on.
 * Absent fields are omitted, never present-but-undefined, so a spread cannot
 * shadow an adapter default.
 */
export interface ImageRuntimeSettings {
  providerKey: string;
  apiKey?: string;
  model?: string;
  resolution?: string;
  aspectRatio?: string;
  requestTimeoutMs?: number;
  supportedParams?: string;
}

/** Non-secret LLM runtime settings, resolved env-first with DB config filling gaps. */
export interface LlmRuntimeSettings {
  model: string;
  baseUrl?: string;
  supportsStructuredOutputs: boolean;
  /** Per-generation-call timeout override in ms; unset → the provider default.
   *  Reasoning models routinely need well beyond the 30s default. */
  requestTimeoutMs?: number;
  /** Reasoning effort override; unset → the preset default (`openai`: medium). */
  reasoningEffort?: LlmReasoningEffort;
}

/** A positive integer millisecond count from an env string / stored value, else
 *  undefined — a malformed timeout silently falls back to the provider default. */
export function parseTimeoutMs(value: unknown): number | undefined {
  const parsed =
    typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : (value as number);
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0
    ? Math.trunc(parsed)
    : undefined;
}

/**
 * Resolve the LLM's non-secret runtime settings (model / base URL / structured-
 * output support / request timeout). Same contract as the secret
 * (`readEnvLayer`): the env's `LLM_MODEL` / `LLM_BASE_URL` /
 * `LLM_SUPPORTS_STRUCTURED_OUTPUTS` / `LLM_REQUEST_TIMEOUT_MS` describe the
 * `LLM_PROVIDER`-named provider only, so they apply solely when env names the
 * resolved provider — a stale env model can never be mis-attributed to a
 * DB-configured provider. Per field, env wins and the credential row's stored
 * `config` fills the gaps. The structured-outputs env flag is tri-state so
 * env-wins holds for it too: `"true"`/`"false"` decide outright (an explicit env
 * `false` overrides a stored `true`); unset or any other value defers to the
 * stored config.
 */
export function resolveLlmRuntimeSettings(input: {
  providerKey: string;
  storedConfig?: Record<string, unknown> | null;
  env?: NodeJS.ProcessEnv;
}): LlmRuntimeSettings {
  const env = input.env ?? process.env;
  const envApplies = env.LLM_PROVIDER?.trim() === input.providerKey;
  const stored = input.storedConfig ?? {};
  const { model = '', baseUrl } = resolveProviderSettings('llm', input.providerKey, stored, env);
  const envStructured = envApplies ? env.LLM_SUPPORTS_STRUCTURED_OUTPUTS?.trim() : undefined;
  const supportsStructuredOutputs =
    envStructured === 'true' || envStructured === 'false'
      ? envStructured === 'true'
      : stored.supportsStructuredOutputs === true;
  const requestTimeoutMs =
    (envApplies ? parseTimeoutMs(env.LLM_REQUEST_TIMEOUT_MS) : undefined) ??
    parseTimeoutMs(stored.requestTimeoutMs);
  // Like the timeout: a blank/unknown effort value is dropped (the preset default
  // applies) rather than reaching the provider API and failing every call.
  const reasoningEffort =
    (envApplies ? normalizeReasoningEffort(env.LLM_REASONING_EFFORT) : undefined) ??
    normalizeReasoningEffort(stored.reasoningEffort);

  return {
    model,
    ...(baseUrl ? { baseUrl } : {}),
    supportsStructuredOutputs,
    ...(requestTimeoutMs != null ? { requestTimeoutMs } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

/**
 * Apply the resolution order to a single requirement: env wins when present,
 * otherwise the database fills the gap, otherwise the credential is unconfigured.
 */
export function resolveCredentialSource(
  envSecret: string | undefined,
  hasDbSecret: boolean,
): CredentialSource | null {
  if (envSecret) return 'env';
  if (hasDbSecret) return 'database';
  return null;
}
