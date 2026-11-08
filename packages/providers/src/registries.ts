// Provider selection. Web and worker call these builders with ALREADY-RESOLVED
// runtime config (env -> DB resolution happens in the caller) instead of importing
// a concrete vendor adapter, so the active provider for each type — and the
// mock-vs-real choice — flows through one place. This keeps `@liedmotif/providers`
// free of any database dependency.

import { ProviderConfigError } from './errors';
import { MOCK_MUSIC_CAPABILITIES, mockMusicProvider } from './music/mock';
import { SUNO_BASE_CAPABILITIES, sunoMusicProvider } from './music/suno';
import { mockLlmProvider } from './llm/mock';
import type { LlmReasoningEffort } from '@liedmotif/shared';
import {
  createOllamaLlmProvider,
  createOpenAiCompatibleLlmProvider,
  createOpenAiLlmProvider,
  createOpenRouterLlmProvider,
} from './llm/openai-compatible';
import {
  openRouterImageProvider,
  parseOpenRouterImageParams,
  type GeneratedImageProvider,
} from './images/generated';
import { sunoCoverImageProvider } from './images/suno-cover';
import type { MusicProvider } from './music/index';
import type { LlmProvider } from './llm/index';

// --- Music ------------------------------------------------------------------

const MUSIC_PROVIDER_SELECTIONS = ['mock', 'suno'] as const;

/** Music selection: the dev `mock` or the real `suno` adapter. */
export type MusicProviderSelection = (typeof MUSIC_PROVIDER_SELECTIONS)[number];

/**
 * Read a `MUSIC_PROVIDER` value: unset or blank selects the dev `mock`. An unknown
 * name throws, so a typo fails at boot rather than on the first Track — unlike a
 * missing key, which the app itself can supply later.
 */
export function musicProviderSelection(value: string | undefined): MusicProviderSelection {
  const selection = value?.trim() || 'mock';
  if (!(MUSIC_PROVIDER_SELECTIONS as readonly string[]).includes(selection)) {
    throw new Error(`Unknown music provider: ${selection}`);
  }
  return selection as MusicProviderSelection;
}

/** Tracks one provider call yields — fixed per provider, so it needs no key. */
export function musicTracksPerRequest(selection: MusicProviderSelection): number {
  const capabilities = selection === 'suno' ? SUNO_BASE_CAPABILITIES : MOCK_MUSIC_CAPABILITIES;
  return capabilities.typicalTracksPerRequest;
}

/**
 * Already-resolved runtime config for the real music provider (env -> DB
 * resolution happens in the caller). The key is required ONLY when `suno` is the
 * active selection, so a `mock` deployment never needs a Suno key.
 */
export interface MusicRuntimeConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  callbackUrl?: string;
}

export function buildMusicProvider(
  selection: MusicProviderSelection = 'mock',
  config: MusicRuntimeConfig = {},
): MusicProvider {
  switch (selection) {
    case 'mock':
      return mockMusicProvider();
    case 'suno': {
      const apiKey = config.apiKey?.trim();
      // The key is only required here — selecting `suno` without one is the error,
      // not merely having `suno` available (don't require it at load).
      if (!apiKey) {
        throw new ProviderConfigError(
          'The Suno music provider needs an API key: save it under Settings → Providers, or set SUNO_API_KEY.',
        );
      }
      return sunoMusicProvider({
        apiKey,
        ...(config.baseUrl?.trim() ? { baseUrl: config.baseUrl.trim() } : {}),
        ...(config.model?.trim() ? { defaultModel: config.model.trim() } : {}),
        ...(config.callbackUrl?.trim() ? { callbackUrl: config.callbackUrl.trim() } : {}),
      });
    }
    default:
      throw new Error(`Unknown music provider: ${String(selection)}`);
  }
}

// --- Text LLM (optional) ----------------------------------------------------

export interface LlmRuntimeConfig {
  providerKey: 'openai' | 'openrouter' | 'openai-compatible' | 'ollama' | 'mock';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  supportsStructuredOutputs?: boolean;
  /** Per-generation-call timeout override in ms; unset → the provider default. */
  requestTimeoutMs?: number;
  /** Reasoning effort override; unset → the preset default (`openai`: high). */
  reasoningEffort?: LlmReasoningEffort;
}

/** The resolved non-secret LLM runtime settings (`@liedmotif/db`'s env->DB
 *  resolution output), structurally — this package stays free of a DB dependency. */
export interface ResolvedLlmSettings {
  model: string;
  baseUrl?: string;
  supportsStructuredOutputs: boolean;
  requestTimeoutMs?: number;
  reasoningEffort?: LlmReasoningEffort;
}

/**
 * Assemble the `buildLlmProvider` input from a resolved provider key, resolved
 * runtime settings, and the resolved secret. The one place the settings->config
 * mapping lives, so web and worker cannot drift on which fields reach the
 * builder; optional fields are OMITTED (never a present `undefined`) so they
 * cannot shadow a preset default.
 */
export function assembleLlmRuntimeConfig(input: {
  providerKey: string;
  settings: ResolvedLlmSettings;
  apiKey: string | null;
}): LlmRuntimeConfig {
  const { providerKey, settings, apiKey } = input;
  return {
    providerKey: providerKey as LlmRuntimeConfig['providerKey'],
    model: settings.model,
    supportsStructuredOutputs: settings.supportsStructuredOutputs,
    ...(apiKey ? { apiKey } : {}),
    ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
    ...(settings.requestTimeoutMs != null ? { requestTimeoutMs: settings.requestTimeoutMs } : {}),
    ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
  };
}

/**
 * Build the configured text LLM, or `null` when it is absent OR not fully usable.
 * The text LLM is optional: a partially-configured real preset (missing
 * model / required key / base URL) is treated as absent rather than built into a
 * provider that 401s later — the structured path still works without any LLM. An
 * UNKNOWN provider key throws (a misconfigured `LLM_PROVIDER`, like music).
 */
export function buildLlmProvider(config: LlmRuntimeConfig | null): LlmProvider | null {
  if (!config) return null;
  if (config.providerKey === 'mock') return mockLlmProvider();
  // A real preset needs a model to be usable — except `openai`, whose preset
  // supplies a well-known default model when none is configured.
  if (!config.model.trim() && config.providerKey !== 'openai') return null;

  const supportsStructuredOutputs = config.supportsStructuredOutputs ?? false;
  const baseUrl = config.baseUrl?.trim();
  const apiKey = config.apiKey?.trim();
  const timeout =
    config.requestTimeoutMs != null ? { requestTimeoutMs: config.requestTimeoutMs } : {};
  const reasoningEffort = config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {};

  switch (config.providerKey) {
    case 'ollama':
      // Ollama needs no API key; the base URL defaults to localhost.
      return createOllamaLlmProvider({
        model: config.model,
        supportsStructuredOutputs,
        ...(baseUrl ? { baseUrl } : {}),
        ...reasoningEffort,
        ...timeout,
      });
    case 'openai':
      // Hosted OpenAI: only the key is required — model and reasoning effort have
      // preset defaults (gpt-6-luna, high).
      return apiKey
        ? createOpenAiLlmProvider({
            apiKey,
            model: config.model,
            supportsStructuredOutputs,
            ...(baseUrl ? { baseUrl } : {}),
            ...reasoningEffort,
            ...timeout,
          })
        : null;
    case 'openrouter':
      return apiKey
        ? createOpenRouterLlmProvider({
            apiKey,
            model: config.model,
            supportsStructuredOutputs,
            ...(baseUrl ? { baseUrl } : {}),
            ...reasoningEffort,
            ...timeout,
          })
        : null;
    case 'openai-compatible':
      // The generic preset needs both an explicit base URL and an API key.
      return apiKey && baseUrl
        ? createOpenAiCompatibleLlmProvider({
            providerKey: 'openai-compatible',
            baseUrl,
            apiKey,
            model: config.model,
            supportsStructuredOutputs,
            ...reasoningEffort,
            ...timeout,
          })
        : null;
    default:
      throw new Error(`Unknown text LLM provider: ${String(config.providerKey)}`);
  }
}

// --- Image (cover art) ------------------------------------------------------

const IMAGE_PROVIDER_SELECTIONS = ['openrouter'] as const;

/** The generated-cover presets: `openrouter` is the only one. */
export type ImageProviderSelection = (typeof IMAGE_PROVIDER_SELECTIONS)[number];

/**
 * Read an `IMAGE_PROVIDER` value: unset or blank names none, which leaves the
 * choice to a key saved in the app. An unknown name throws, so a typo fails at boot
 * rather than silently painting no covers — unlike a missing key, which the app
 * itself can supply later.
 */
export function imageProviderSelection(value: string | undefined): ImageProviderSelection | null {
  const selection = value?.trim();
  if (!selection) return null;
  if (!(IMAGE_PROVIDER_SELECTIONS as readonly string[]).includes(selection)) {
    throw new Error(`Unknown image provider: ${selection}`);
  }
  return selection as ImageProviderSelection;
}

/**
 * Already-resolved runtime config for the async generated-cover provider
 * (env -> DB resolution happens in the caller, like the other builders).
 */
export interface GeneratedImageRuntimeConfig {
  providerKey: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  resolution?: string;
  aspectRatio?: string;
  requestTimeoutMs?: number;
  /** Operator assertion for discovery outages. It can only narrow a discovered
   * endpoint descriptor; unknown names are dropped. */
  supportedParams?: string;
}

/**
 * Build the configured generated-cover provider, or `null` when absent or not
 * fully usable (no key) — generated cover art is optional and cosmetic, so a
 * partial config degrades to "no generated covers", never to a provider that
 * 401s later. An unknown provider key throws (a misconfigured IMAGE_PROVIDER).
 */
export function buildGeneratedImageProvider(
  config: GeneratedImageRuntimeConfig | null,
): GeneratedImageProvider | null {
  if (!config) return null;
  if (config.providerKey !== 'openrouter') {
    throw new Error(`Unknown image provider: ${String(config.providerKey)}`);
  }
  const apiKey = config.apiKey?.trim();
  if (!apiKey) return null;
  const supportedParams = parseOpenRouterImageParams(config.supportedParams);
  return openRouterImageProvider({
    apiKey,
    ...(config.model?.trim() ? { model: config.model.trim() } : {}),
    ...(config.baseUrl?.trim() ? { baseUrl: config.baseUrl.trim() } : {}),
    ...(config.resolution?.trim() ? { resolution: config.resolution.trim() } : {}),
    ...(config.aspectRatio?.trim() ? { aspectRatio: config.aspectRatio.trim() } : {}),
    ...(config.requestTimeoutMs != null ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
    ...(supportedParams ? { capabilityAssertion: { supportedParameters: supportedParams } } : {}),
  });
}

/**
 * Build the Suno cover-art FALLBACK provider from the music provider's runtime
 * config (same key/base URL), or `null` when the key is absent. Like the other
 * cosmetic builders, a partial config degrades to "no Suno covers" rather than
 * a provider that 401s later. The caller decides WHEN this fallback applies
 * (only while no prompt-driven image provider is configured and the owner has
 * opted in) — this builder only answers whether it is buildable at all.
 */
export function buildSunoCoverImageProvider(
  config: Pick<MusicRuntimeConfig, 'apiKey' | 'baseUrl'> | null,
): GeneratedImageProvider | null {
  const apiKey = config?.apiKey?.trim();
  if (!apiKey) return null;
  return sunoCoverImageProvider({
    apiKey,
    ...(config?.baseUrl?.trim() ? { baseUrl: config.baseUrl.trim() } : {}),
  });
}
