// Single source of truth for the text-LLM presets and their per-preset
// requirements. Pure data with no server imports, so both client (setup wizard)
// and server (validation, settings) derive from the SAME matrix — the wizard can
// never accept a config the server validator would reject.

import { OPENAI_DEFAULT_LLM_MODEL } from '@liedmotif/shared';

export interface LlmProviderMeta {
  value: 'openai' | 'openrouter' | 'openai-compatible' | 'ollama';
  label: string;
  /** Whether this preset requires an API key. */
  needsKey: boolean;
  /** Whether this preset requires an explicit base URL. */
  needsBaseUrl: boolean;
  /** Model the preset falls back to at runtime; a preset with one accepts a
   *  model-less config (the model field becomes optional in wizard/settings). */
  defaultModel?: string;
  /** Whether a successful Test lists the installed models, so it can run before
   *  a model is chosen and its result can fill the model picker. */
  listsModels?: boolean;
  /** Example base URL shown in an empty base-URL field. */
  baseUrlPlaceholder?: string;
  /** The provider picker lists this preset only once More options is opened. */
  behindMoreOptions?: boolean;
}

/** In picker order: the main presets, then those behind More options. */
export const LLM_PROVIDERS: readonly LlmProviderMeta[] = [
  {
    value: 'openai',
    label: 'OpenAI',
    needsKey: true,
    needsBaseUrl: false,
    defaultModel: OPENAI_DEFAULT_LLM_MODEL,
  },
  {
    value: 'ollama',
    label: 'Ollama',
    needsKey: false,
    needsBaseUrl: true,
    listsModels: true,
    // Same-machine Ollama as the Docker deployment reaches it; `localhost` natively.
    baseUrlPlaceholder: 'http://host.docker.internal:11434',
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    needsKey: true,
    needsBaseUrl: false,
    behindMoreOptions: true,
  },
  {
    value: 'openai-compatible',
    label: 'OpenAI-compatible',
    needsKey: true,
    needsBaseUrl: true,
    behindMoreOptions: true,
  },
];

export type LlmProviderKey = LlmProviderMeta['value'];

export const LLM_PROVIDER_KEYS: readonly LlmProviderKey[] = LLM_PROVIDERS.map((p) => p.value);

/** Look up a preset's requirements by key. */
export function llmProviderMeta(key: string): LlmProviderMeta | undefined {
  return LLM_PROVIDERS.find((p) => p.value === key);
}

/**
 * The one model-requirement rule, shared by wizard/settings/server validation: a
 * preset without a runtime model default needs an explicit model — without one
 * the LLM can never actually be built (`buildLlmProvider` returns null). Presets
 * with a default (openai) stay usable model-less.
 */
export function llmModelMissing(
  meta: Pick<LlmProviderMeta, 'defaultModel'> | undefined,
  model: string | undefined,
): boolean {
  return llmEffectiveModel(meta, model) === null;
}

export function llmEffectiveModel(
  meta: Pick<LlmProviderMeta, 'defaultModel'> | undefined,
  model: string | undefined,
): string | null {
  return model?.trim() || meta?.defaultModel || null;
}
