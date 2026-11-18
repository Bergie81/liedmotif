// Text-LLM reasoning-effort vocabulary and the hosted OpenAI and Gemini preset defaults.
//
// The effort values are the OpenAI `reasoning_effort` API's. They live in shared —
// not in `@liedmotif/providers` — because credential resolution (`@liedmotif/db`) and
// the provider adapters both consume them and must agree without depending on each
// other; the web UI's preset matrix also reads the model default (shared is
// client-safe, the providers package is not).

// The union of values across OpenAI model generations — which subset a given
// model accepts is model-dependent (e.g. GPT-5.6 takes none…max but not
// minimal), so the API stays the authority; this list only guards against typos.
export const LLM_REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type LlmReasoningEffort = (typeof LLM_REASONING_EFFORTS)[number];

/** Default model for the hosted `openai` LLM preset — applied by the preset when no
 *  model is configured, and surfaced as the UI's model-field default. */
export const OPENAI_DEFAULT_LLM_MODEL = 'gpt-6-luna';

/** Default reasoning effort for the hosted `openai` LLM preset. */
export const OPENAI_DEFAULT_REASONING_EFFORT: LlmReasoningEffort = 'high';

/** Default model for the hosted `gemini` LLM preset, applied like the openai one. */
export const GEMINI_DEFAULT_LLM_MODEL = 'gemini-3.8-flash';

/** Default reasoning effort for the hosted `gemini` LLM preset. */
export const GEMINI_DEFAULT_REASONING_EFFORT: LlmReasoningEffort = 'low';

/**
 * A valid reasoning effort from arbitrary input (env var, stored credential
 * config), else `undefined` — a blank or unknown value silently falls back to the
 * preset default rather than reaching the provider API and failing every call.
 */
export function normalizeReasoningEffort(value: unknown): LlmReasoningEffort | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return (LLM_REASONING_EFFORTS as readonly string[]).includes(normalized)
    ? (normalized as LlmReasoningEffort)
    : undefined;
}
