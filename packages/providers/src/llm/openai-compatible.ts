// Generic OpenAI-compatible text-LLM adapter (Vercel AI SDK Core), with OpenRouter
// and Ollama presets. The text LLM is OPTIONAL. In the music path it is only used
// for the free-text/voice expansion path; structured controls never reach here.
// Outside it, the Assistant's replies run through `streamAssistantReply`.
//
// Security: the base URL is configurable, so EVERY outbound call (credential probe
// and generation) is gated by the SSRF guard first and then dialed through the
// pinned transport, which connects only to the addresses that gate vetted. Raw
// provider/SDK errors are never surfaced — methods throw a sanitized
// `ProviderError` or fall back.
//
// Structured-output robustness: when the model supports strict structured outputs
// we ask for a schema-validated `Output.object`; otherwise we ask for JSON in the
// prompt and run the reply through `safeParse`. Either way a single repair retry
// runs on a parse failure.

import {
  generateText,
  isStepCount,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  streamText,
  tool,
  type JSONValue,
  type LanguageModel,
} from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  COVER_STYLE_PRESETS,
  GEMINI_DEFAULT_LLM_MODEL,
  GEMINI_DEFAULT_REASONING_EFFORT,
  MAX_COVER_GUIDANCE_LENGTH,
  narrowTo,
  OPENAI_DEFAULT_LLM_MODEL,
  OPENAI_DEFAULT_REASONING_EFFORT,
  type CoverStylePreset,
  type LlmReasoningEffort,
} from '@liedmotif/shared';
import { z } from 'zod';
import { ProviderConfigError, ProviderError } from '../errors';
import type { ProviderValidationResult } from '../types';
import { validateCredential } from '../validation/index';
import { pinnedProviderFetch } from '../validation/provider-fetch';
import { assertAllowedBaseUrl } from '../validation/ssrf';
import {
  clampLyricContext,
  clampTrackLyricBrief,
  clampTrackTitles,
  ENERGY_LEVELS,
  sanitizeLanguage,
  sessionStyleSnapshotSchema,
  type SessionStyleSnapshot,
} from './snapshot';
import { clampCoverConcept, type SessionNamingMetadata } from './session-title';
import {
  allowsLyricContext,
  allowsNamingLyricContext,
  expansionPrompt,
  jsonExpansionPrompt,
  jsonRepairPrompt,
  MAX_SURPRISE_REQUEST_LENGTH,
  namingPrompt,
  NAMED_VISUAL_REFERENCE_RULE,
  structuredRepairPrompt,
  SURPRISE_MINUTES,
  surpriseRequestPrompt,
  trackLyricBriefPrompt,
  trackTitlesPrompt,
  type ExpansionOptions,
  type TrackLyricBriefInput,
  type TrackTitlesInput,
} from './session-prompts';
import {
  applyStylePicks,
  deriveTrackMetadata,
  freezeStyleParameters,
  type StylePicks,
  type TrackMetadata,
} from './template';
import type {
  AssistantReplyInput,
  CoverDirectionInput,
  ListenerContext,
  LlmProvider,
  LlmProviderCapabilities,
  SessionNamingInput,
} from './index';

/** A pick spelled with other case or separators ("Record Sleeve", "poster-art")
 *  read as the preset it spells, or null. */
function looseCoverStylePick(value: unknown): CoverStylePreset | null {
  if (typeof value !== 'string') return null;
  return narrowTo(
    COVER_STYLE_PRESETS,
    value
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_'),
  );
}

/** The Auto cover pick (ADR 0007): one of the six presets, and anything else,
 *  missing included, is no pick rather than a failed reply. The schema sent to
 *  the model stays the plain enum; the fallback reads only the spelling. */
const coverStylePickSchema = z
  .enum(COVER_STYLE_PRESETS)
  .nullable()
  .catch((ctx) => looseCoverStylePick(ctx?.input));

/**
 * What an expansion may contain: the snapshot minus the Session Guardrails and
 * the own-voice opt-in. Both are user picks the producer stamps (`applyGuardrails`,
 * `applyStylePicks`), never creative output — omitting them here means a model
 * that volunteers a maxed-out novelty, its own Avoid text, or a cloned-voice
 * opt-in the user never gave cannot have it survive the parse, on the structured
 * and the JSON-in-text path alike.
 */
const sessionExpansionSchema = sessionStyleSnapshotSchema
  .omit({ styleStrength: true, novelty: true, userAvoid: true, useOwnVoice: true })
  .extend({
    coverConcept: z.string().default('').transform(clampCoverConcept),
    coverStyle: coverStylePickSchema,
    requestedDurationMinutes: z.number().nullable().optional(),
    includesListener: z.boolean().nullable().optional(),
  });

/**
 * What the model is asked for: the expansion minus `seedParameters`. The seed is
 * producer-owned — `freezeStyleParameters` always overwrites it from the style
 * prompt — and its record shape serializes to `propertyNames`, which hosted
 * OpenAI's strict `json_schema` subset rejects, failing the whole call with a
 * 400 before the model runs. Structured output is parsed back through the full
 * schema so the field's default is present on the returned expansion.
 */
const sessionExpansionRequestSchema = sessionExpansionSchema.omit({ seedParameters: true });

type SessionExpansion = z.infer<typeof sessionExpansionSchema>;

export type LlmProviderKey = 'openai' | 'gemini' | 'openai-compatible' | 'openrouter' | 'ollama';

export interface OpenAiCompatibleLlmConfig {
  providerKey: LlmProviderKey;
  /** Generation base URL — OpenAI-compatible, includes `/v1` where applicable. */
  baseUrl: string;
  apiKey?: string;
  model: string;
  supportsStructuredOutputs: boolean;
  headers?: Record<string, string>;
  /** Base URL for the credential-validation probe; defaults to `baseUrl`. */
  validationBaseUrl?: string;
  /** Injectable `fetch` for every outbound call — generation and the credential
   *  probe alike (tests); defaults to the address-pinning transport. */
  fetchImpl?: typeof fetch;
  /** Injectable language model (tests); otherwise built from the config. */
  languageModel?: LanguageModel;
  /** Per-generation-call timeout in ms (the create flow must never hang). */
  requestTimeoutMs?: number;
  /** SDK network retries per call. Kept low — generation costs real money. */
  maxRetries?: number;
  /** Reasoning effort forwarded as `reasoning_effort` on every generation call
   *  (hosted reasoning models; ignored by providers that don't know the field).
   *  The Assistant's call to hosted OpenAI goes out at `none` instead. */
  reasoningEffort?: LlmReasoningEffort;
}

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const OLLAMA_DEFAULT_ROOT = 'http://localhost:11434';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 1;
const MAX_RETRIES_CEILING = 3;

/**
 * Clamp the configured SDK retry count to an INTEGER in `[0, ceiling]`. Generation
 * costs real money, so a server-side misconfiguration must not drive a high retry
 * count (cost controls are on by default). Non-integers/NaN are coerced —
 * the AI SDK rejects a non-integer `maxRetries`, which would otherwise break every
 * generation call.
 */
export function clampMaxRetries(value: number | undefined): number {
  const truncated = Math.trunc(value ?? DEFAULT_MAX_RETRIES);
  if (Number.isNaN(truncated)) return DEFAULT_MAX_RETRIES;
  // ±Infinity clamps to the ceiling / 0 via min/max.
  return Math.max(0, Math.min(MAX_RETRIES_CEILING, truncated));
}

const EXPANSION_FAILED =
  'Could not turn that description into a music style. Check the text AI configuration.';
const EXPANSION_TIMED_OUT =
  'The text AI took too long to respond. Try again, or use a faster model.';

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Non-secret diagnostics from a failed SDK call, for `ProviderError.safeDetail`:
 * error NAME, HTTP status, and a timeout flag only. Deliberately never the error
 * message or response body — the AI SDK embeds the provider's raw response in
 * both, which must not reach logs.
 */
function safeErrorSummary(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { errorName: typeof err };
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  return {
    errorName: err.name,
    ...(typeof statusCode === 'number' ? { statusCode } : {}),
    ...(err.name === 'AbortError' || err.name === 'TimeoutError' ? { timedOut: true } : {}),
  };
}

/** Sanitized failure of a call. A timeout gets its own actionable message — the
 *  configuration is usually fine, the model was just slow (reasoning models
 *  routinely take 25s+) — while everything else gets the call's own `failed`
 *  message. The summary stays attached as the loggable `safeDetail`. */
function sanitizedError(err: unknown, failed: string): ProviderError {
  const summary = safeErrorSummary(err);
  return new ProviderError(summary.timedOut ? EXPANSION_TIMED_OUT : failed, summary);
}

/** Pull the first JSON object out of a model response (tolerating prose / fences). */
function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  // If the model wrapped the JSON in prose or markdown fences, also try the
  // substring between the first `{` and the last `}`.
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function parseSnapshot(text: string): SessionExpansion | null {
  const result = sessionExpansionSchema.safeParse(parseJsonObject(text));
  return result.success ? result.data : null;
}

/** A usable cosmetic title/artist pair from a model response, or null. */
function parseTrackMetadata(text: string): TrackMetadata | null {
  const parsed = parseJsonObject(text) as Partial<TrackMetadata> | undefined;
  const title = typeof parsed?.title === 'string' ? parsed.title.trim() : '';
  const artistName = typeof parsed?.artistName === 'string' ? parsed.artistName.trim() : '';
  return title && artistName ? { title, artistName } : null;
}

/** Ceiling for the cosmetic naming call (`createSessionMetadata`): it is awaited in
 *  the create/restyle request path before the session row exists, so it gets a much
 *  tighter budget than an expansion — a slow model costs at most this, never the
 *  full generation timeout. */
const NAMING_TIMEOUT_MS = 10_000;
const COVER_DIRECTION_TIMEOUT_MS = 10_000;

/**
 * One prompt for the cover-direction rewrite: best-practice image-prompt
 * phrasing (concrete subjects, palette, materials, lighting), with the safe
 * session context informing — never overriding — the user's intent.
 */
function coverDirectionPrompt(input: CoverDirectionInput): string {
  const context = [
    input.context.sessionName ? `Session name: ${input.context.sessionName}` : '',
    input.context.style ? `Cover style lane: ${input.context.style}` : '',
    input.context.mood ? `Mood: ${input.context.mood}` : '',
    input.context.genres?.length ? `Genres: ${input.context.genres.join(', ')}` : '',
    input.context.imageModel ? `Target image model: ${input.context.imageModel}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    `Rewrite the user's cover-art direction into concise, concrete visual language an AI image model follows well: ` +
    `subjects, composition, palette, materials, and lighting. Keep the user's intent and subjects. ` +
    `${NAMED_VISUAL_REFERENCE_RULE} ` +
    `Never add artist names, brands, quality tokens ("masterpiece", "8k"), or requests for text or lettering. ` +
    `Respond with ONLY a JSON object: direction (string, the rewritten direction as one short paragraph), ` +
    `includesListener (boolean: true ONLY when the user's direction places the listener themself in the ` +
    `picture, in any language — "me dancing with Jonas", "my friends and I", "wir am Strand"; false when ` +
    `the picture belongs to other people or to no one).\n\n` +
    (context ? `Context (informs, never overrides):\n${context}\n\n` : '') +
    `User direction:\n${input.text.trim()}`
  );
}

function clampCoverDirection(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_COVER_GUIDANCE_LENGTH).trim();
}

/** The cover-direction answer; each field is kept or dropped on its own. */
const coverDirectionSchema = z.object({
  direction: z.string().catch(''),
  includesListener: z.boolean().optional().catch(undefined),
});

/** The track-title refill response shape (`createTrackTitles`). */
const trackTitlesSchema = z.object({ trackTitles: z.array(z.string()).default([]) });
const surpriseRequestSchema = z.object({
  request: z
    .string()
    .transform((text) => text.replace(/\s+/g, ' ').trim().slice(0, MAX_SURPRISE_REQUEST_LENGTH))
    .pipe(z.string().min(1)),
  energy: z.enum(ENERGY_LEVELS).catch('medium'),
  durationMinutes: z
    .number()
    .catch(SURPRISE_MINUTES.fallback)
    .transform((minutes) =>
      Math.min(SURPRISE_MINUTES.max, Math.max(SURPRISE_MINUTES.min, Math.round(minutes / 5) * 5)),
    ),
});
const SURPRISE_REQUEST_FAILED = 'The text AI could not write a surprise. Try again.';
const ASSISTANT_REPLY_FAILED = 'The text AI could not answer. Try again.';
const ASSISTANT_REPLY_CUT_OFF = 'The text AI stopped before the answer was finished. Try again.';

/** The creative-naming response shape (`createSessionMetadata`); all default so
 *  a partial reply still validates and consumers keep their deterministic fallback. */
const sessionNamingSchema = z.object({
  title: z.string().default(''),
  trackTitles: z.array(z.string()).default([]),
  lyricContext: z.string().default(''),
  coverConcept: z.string().default(''),
  coverStyle: coverStylePickSchema,
});

/** A usable naming proposal from a model value, or null. The title is required —
 *  without a name the reply is useless even if it carried a track-title pool. The
 *  pool and lyric context are clamped here (the write boundary: they merge straight
 *  into the stored snapshot, no schema parse in between). */
function normalizeSessionNaming(value: unknown): SessionNamingMetadata | null {
  const result = sessionNamingSchema.safeParse(value);
  if (!result.success || !result.data.title.trim()) return null;
  return {
    title: result.data.title.trim(),
    trackTitles: clampTrackTitles(result.data.trackTitles),
    lyricContext: clampLyricContext(result.data.lyricContext),
    coverConcept: clampCoverConcept(result.data.coverConcept),
    autoCoverStyle: result.data.coverStyle,
  };
}

export function createOpenAiCompatibleLlmProvider(config: OpenAiCompatibleLlmConfig): LlmProvider {
  const validationBaseUrl = config.validationBaseUrl ?? config.baseUrl;
  const maxRetries = clampMaxRetries(config.maxRetries);
  const timeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let model: LanguageModel | undefined = config.languageModel;

  /**
   * The transport BOTH outbound calls share (generation and the credential
   * probe): connect-time pinned to the addresses vetted for the configured host,
   * so a name rebound since the admin saved it is refused as the call goes out.
   */
  const providerFetch =
    config.fetchImpl ?? pinnedProviderFetch({ providerKey: config.providerKey });

  /**
   * Generation additionally refuses to follow redirects, so a provider that
   * passed the host check cannot 302 the SDK to a private/metadata host
   * mid-request (mirrors the credential probe's `redirect: 'manual'`).
   */
  const noRedirectFetch: typeof fetch = (input, init) =>
    providerFetch(input, { ...init, redirect: 'manual' });

  function getModel(): LanguageModel {
    if (!model) {
      model = createOpenAICompatible({
        name: config.providerKey,
        baseURL: config.baseUrl,
        fetch: noRedirectFetch,
        // Must reach the SDK model: it decides the object-generation wire format,
        // and its default `json_object` mode is rejected by hosted OpenAI unless
        // the prompt contains the word "JSON" — strict `json_schema` carries the
        // schema instead and needs no such marker.
        supportsStructuredOutputs: config.supportsStructuredOutputs,
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        ...(config.headers ? { headers: config.headers } : {}),
      }).chatModel(config.model);
    }
    return model;
  }

  // Per-call provider options, in the wire shape the vendor expects.
  //
  // `strictJsonSchema: false` on every call: hosted OpenAI validates a strict
  // `json_schema` against its narrow subset — every property required, no
  // `propertyNames`, no plain optionality — and 400s the whole call otherwise.
  // The expansion schema's defaulted fields are deliberately optional so a
  // weak/partial model response still validates, so constrained decoding is
  // off and schema conformance stays enforced by the local zod parse. The SDK
  // reads the flag (like `reasoningEffort`) from the `openaiCompatible` key it
  // parses for every preset built here regardless of the preset's own name.
  //
  // The configured reasoning effort rides alongside. OpenRouter's unified
  // parameter is a `reasoning: { effort }` body field — injected through the
  // preset-named provider-options key, whose unknown entries the SDK adapter
  // spreads verbatim into the request body. Every other preset takes the
  // OpenAI-style `reasoning_effort`.
  // Widened to the SDK's provider-options shape: the wire formats as a plain
  // union carry phantom `?: undefined` props that fail its Record type.
  function providerOptionsAt(
    reasoningEffort: LlmReasoningEffort | undefined,
  ): Record<string, Record<string, JSONValue>> {
    return {
      openaiCompatible: {
        strictJsonSchema: false,
        ...(reasoningEffort && config.providerKey !== 'openrouter' ? { reasoningEffort } : {}),
      },
      ...(reasoningEffort && config.providerKey === 'openrouter'
        ? { openrouter: { reasoning: { effort: reasoningEffort } } }
        : {}),
    };
  }
  const providerOptions = providerOptionsAt(config.reasoningEffort);
  // Hosted OpenAI's chat-completions endpoint answers 400 to function tools
  // sent with any reasoning effort but `none`, so a call that offers tools goes
  // out with reasoning off there. A model configured without an effort gets
  // none named: it may not know the field.
  const toolCallProviderOptions =
    config.providerKey === 'openai' && config.reasoningEffort
      ? providerOptionsAt('none')
      : providerOptions;
  /** Bounded call settings: a fresh per-call timeout (never above the configured
   *  one), cut short by the caller's own signal, a low retry cap, and the
   *  provider options above. */
  function callSettings(budgetMs = timeoutMs, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(Math.min(budgetMs, timeoutMs));
    return {
      abortSignal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      maxRetries,
      providerOptions,
    };
  }

  async function expandViaStructuredOutput(
    intent: string,
    listener?: ListenerContext | null,
    picks?: StylePicks,
    options?: ExpansionOptions,
  ): Promise<SessionExpansion> {
    let lastError: unknown;
    for (const prompt of [
      expansionPrompt(intent, listener, picks, options),
      structuredRepairPrompt(intent, listener, picks, options),
    ]) {
      try {
        const { output } = await generateText({
          model: getModel(),
          output: Output.object({ schema: sessionExpansionRequestSchema }),
          prompt,
          ...callSettings(timeoutMs, options?.signal),
        });
        return sessionExpansionSchema.parse(output);
      } catch (err) {
        // Only an answer that failed to parse earns the repair prompt; a
        // timeout or a refused call would fail the same way a second time.
        const unparsed =
          NoObjectGeneratedError.isInstance(err) ||
          NoOutputGeneratedError.isInstance(err) ||
          err instanceof z.ZodError;
        if (!unparsed) throw sanitizedError(err, EXPANSION_FAILED);
        lastError = err;
      }
    }
    throw sanitizedError(lastError, EXPANSION_FAILED);
  }

  async function expandViaJsonText(
    intent: string,
    listener?: ListenerContext | null,
    picks?: StylePicks,
    options?: ExpansionOptions,
  ): Promise<SessionExpansion> {
    const first = await generateText({
      model: getModel(),
      prompt: jsonExpansionPrompt(intent, listener, picks, options),
      ...callSettings(timeoutMs, options?.signal),
    });
    const parsed = parseSnapshot(first.text);
    if (parsed) return parsed;

    const repaired = await generateText({
      model: getModel(),
      prompt: jsonRepairPrompt(intent, first.text, listener, picks, options),
      ...callSettings(timeoutMs, options?.signal),
    });
    const reparsed = parseSnapshot(repaired.text);
    if (reparsed) return reparsed;
    // The model answered but neither reply parsed/validated as a snapshot — a
    // config smell (model too small, or structured-output support mislabeled).
    throw new ProviderError(EXPANSION_FAILED, { failure: 'unparseable_response' });
  }

  /**
   * Fallback when a VOCAL expansion omitted the request language (or sanitization
   * emptied a junk value): one short-timeout single-question call, so the sung
   * lyrics still match the language the user asked in. Never throws — '' on any
   * failure (no tag, provider default), keeping the expansion path unblockable.
   */
  async function detectRequestLanguage(intent: string): Promise<string> {
    try {
      const { text } = await generateText({
        model: getModel(),
        prompt:
          `What language is this request written in? Reply with ONLY the language's ` +
          `English name (e.g. "German").\n\nRequest: ${intent}`,
        ...callSettings(NAMING_TIMEOUT_MS),
      });
      return sanitizeLanguage(text);
    } catch {
      return '';
    }
  }

  const provider: LlmProvider = {
    providerType: 'llm',
    providerKey: config.providerKey,

    getCapabilities(): LlmProviderCapabilities {
      return { supportsStructuredOutputs: config.supportsStructuredOutputs, model: config.model };
    },

    async validateCredentials(): Promise<ProviderValidationResult> {
      try {
        assertAllowedBaseUrl(config.providerKey, validationBaseUrl);
      } catch (err) {
        if (err instanceof ProviderConfigError) return { ok: false, message: err.message };
        throw err;
      }
      return validateCredential({
        providerType: 'llm',
        providerKey: config.providerKey,
        secret: config.apiKey,
        baseUrl: validationBaseUrl,
        fetchImpl: providerFetch,
      });
    },

    async expandSessionIntentWithMetadata(
      intent: string,
      listener?: ListenerContext | null,
      picks?: StylePicks,
      options?: ExpansionOptions,
    ) {
      // SSRF gate before any generation request reaches the configurable base URL.
      assertAllowedBaseUrl(config.providerKey, config.baseUrl);
      let expanded: SessionExpansion;
      try {
        expanded = config.supportsStructuredOutputs
          ? await expandViaStructuredOutput(intent, listener, picks, options)
          : await expandViaJsonText(intent, listener, picks, options);
      } catch (err) {
        if (err instanceof ProviderError) throw err; // already sanitized
        // Sanitize any raw provider/SDK error, keeping loggable non-secret facts.
        throw sanitizedError(err, EXPANSION_FAILED);
      }
      const {
        coverConcept,
        coverStyle: autoCoverStyle,
        requestedDurationMinutes,
        includesListener,
        ...rawSnapshot
      } = expanded;
      // An adjustment holds the session's frozen blend anchors: a reply that
      // omits bpm/key keeps the CURRENT values instead of re-freezing new ones
      // from energy/genre. The exception is an energy pick that differs from the
      // running energy: the tempo is unfrozen so `freezeStyleParameters`
      // re-derives it from the picked energy. The trigger is the pick against the
      // running vibe, never the model's reply, so the same Change Vibe yields the
      // same tempo whether or not the model obeyed the pick. The prompt never
      // shows the model the running voice, so a vocal reply without one keeps
      // it; the picks below still override it.
      const anchor = options?.adjustFrom;
      const energyChanged = picks?.energy !== undefined && picks.energy !== anchor?.energy;
      const anchored: SessionStyleSnapshot = anchor
        ? {
            ...rawSnapshot,
            useOwnVoice: false,
            bpm: energyChanged ? null : (rawSnapshot.bpm ?? anchor.bpm),
            key: rawSnapshot.key.trim() ? rawSnapshot.key : anchor.key,
            voiceGender:
              rawSnapshot.voiceGender ||
              (rawSnapshot.vocalMode === 'vocal' ? anchor.voiceGender : ''),
          }
        : { ...rawSnapshot, useOwnVoice: false };
      // Explicit fine-tune picks are enforced deterministically FIRST (prompt
      // guidance is never trusted), so everything below — the lyric-context rule,
      // the language backfill — follows the FORCED vocal mode, and the picks join
      // the frozen-BPM fingerprint (a forced energy re-freezes the tempo).
      let snapshot: SessionStyleSnapshot = applyStylePicks(anchored, picks);
      // Enforce the lyric-context rule on the output (the provider is its single
      // owner): a model that fills it anyway — hallucinated personal details, or
      // lyrics for an instrumental session — is corrected here.
      if (snapshot.lyricContext && !allowsLyricContext(snapshot, listener, options)) {
        snapshot = { ...snapshot, lyricContext: '' };
      }
      // A vocal session must know its request language or the sung lyrics drift
      // to the provider default (schema sanitization also empties junk values) —
      // one bounded follow-up question backfills an omission, '' on failure. An
      // instrumental session keeps whatever language it carries (it steers title
      // language; the vocal tail is mode-gated) but never triggers the
      // follow-up call, and neither does a picks-only change: it has no words
      // to detect a language from.
      if (snapshot.vocalMode === 'vocal' && !snapshot.language && intent.trim()) {
        snapshot = { ...snapshot, language: await detectRequestLanguage(intent) };
      }
      // Freeze a BPM/key + seed for blend-readiness. A model-provided
      // BPM is normalized to an integer and a provided key is kept; the hidden seed
      // is always frozen from the style (see `freezeStyleParameters`).
      return {
        snapshot: freezeStyleParameters(snapshot),
        coverConcept,
        autoCoverStyle,
        requestedDurationMinutes: anchor ? null : requestedDurationMinutes,
        includesListener: includesListener ?? undefined,
      };
    },

    async expandSessionIntent(
      intent: string,
      listener?: ListenerContext | null,
      picks?: StylePicks,
      options?: ExpansionOptions,
    ) {
      return (await provider.expandSessionIntentWithMetadata(intent, listener, picks, options))
        .snapshot;
    },

    async createTrackMetadata(
      snapshot: SessionStyleSnapshot,
      trackIndex = 0,
    ): Promise<TrackMetadata> {
      try {
        assertAllowedBaseUrl(config.providerKey, config.baseUrl);
        const { text } = await generateText({
          model: getModel(),
          prompt:
            `Suggest a short cosmetic track title and a fictional artist name for this style. ` +
            `Respond with ONLY JSON: {"title": string, "artistName": string}.\n\n` +
            `Style: ${snapshot.stylePrompt}`,
          ...callSettings(),
        });
        const meta = parseTrackMetadata(text);
        if (meta) return meta;
      } catch {
        // non-blocking: fall back to deterministic metadata
      }
      return deriveTrackMetadata(snapshot, trackIndex);
    },

    async createSessionMetadata(input: SessionNamingInput): Promise<SessionNamingMetadata> {
      // Enforce the lyric-context rule on the output (mirrors `expandSessionIntent`;
      // the provider is the rule's single owner, so consumers merge without re-checking).
      // The gate is fixed for the whole call — a disallowed session drops whatever the
      // model volunteered (`normalizeSessionNaming` has already clamped an allowed one).
      const keepLyricContext = allowsNamingLyricContext(input.snapshot, input.listener);
      try {
        assertAllowedBaseUrl(config.providerKey, config.baseUrl);
        const prompt = namingPrompt(input);
        const settings = callSettings(NAMING_TIMEOUT_MS);
        if (config.supportsStructuredOutputs) {
          const { output } = await generateText({
            model: getModel(),
            output: Output.object({ schema: sessionNamingSchema }),
            prompt,
            ...settings,
          });
          const naming = normalizeSessionNaming(output);
          if (naming) return keepLyricContext ? naming : { ...naming, lyricContext: '' };
        } else {
          const { text } = await generateText({ model: getModel(), prompt, ...settings });
          const naming = normalizeSessionNaming(parseJsonObject(text));
          if (naming) return keepLyricContext ? naming : { ...naming, lyricContext: '' };
        }
      } catch {
        // Naming is cosmetic and must never fail a session creation.
      }
      // No usable proposal → EMPTY metadata. Deterministic naming has one owner:
      // the consumer's `deriveSessionTitle`, which composes the Name whenever the
      // proposal is empty (per-track titles then use the numbered scheme).
      return {
        title: '',
        trackTitles: [],
        lyricContext: '',
        coverConcept: '',
        autoCoverStyle: null,
      };
    },

    async createTrackLyricBrief(input: TrackLyricBriefInput): Promise<string> {
      try {
        assertAllowedBaseUrl(config.providerKey, config.baseUrl);
        // Full configured budget: the brief runs in the async worker between
        // intent-commit and the provider POST — no request is waiting on it,
        // and a reasoning model routinely needs more than the naming-class cap.
        const { text } = await generateText({
          model: getModel(),
          prompt: trackLyricBriefPrompt(input),
          ...callSettings(),
        });
        return clampTrackLyricBrief(text);
      } catch {
        // Best-effort: '' tells the caller to submit the
        // static session notes; no raw provider error may surface.
        return '';
      }
    },

    async createTrackTitles(input: TrackTitlesInput): Promise<string[]> {
      try {
        assertAllowedBaseUrl(config.providerKey, config.baseUrl);
        // Full configured budget, like the lyric brief: it runs in the async
        // worker between intent-commit and the provider POST.
        const { text } = await generateText({
          model: getModel(),
          prompt: trackTitlesPrompt(input),
          ...callSettings(),
        });
        const parsed = trackTitlesSchema.safeParse(parseJsonObject(text));
        if (!parsed.success) return [];
        return clampTrackTitles(parsed.data.trackTitles).slice(0, input.count);
      } catch {
        // Best-effort: [] keeps the pool as it is.
        return [];
      }
    },

    async createSurpriseRequest(input) {
      assertAllowedBaseUrl(config.providerKey, config.baseUrl);
      let text: string;
      try {
        ({ text } = await generateText({
          model: getModel(),
          prompt: surpriseRequestPrompt(input),
          ...callSettings(timeoutMs, input.signal),
        }));
      } catch (err) {
        throw sanitizedError(err, SURPRISE_REQUEST_FAILED);
      }
      const parsed = surpriseRequestSchema.safeParse(parseJsonObject(text));
      if (!parsed.success) {
        throw new ProviderError(SURPRISE_REQUEST_FAILED, { failure: 'unparseable_response' });
      }
      return parsed.data;
    },

    async enhanceCoverDirection(input) {
      const raw = input.text.trim();
      if (!raw) return { text: input.text, applied: false };
      try {
        assertAllowedBaseUrl(config.providerKey, config.baseUrl);
        const { text } = await generateText({
          model: getModel(),
          prompt: coverDirectionPrompt(input),
          ...callSettings(COVER_DIRECTION_TIMEOUT_MS),
        });
        const parsed = coverDirectionSchema.safeParse(parseJsonObject(text));
        if (parsed.success) {
          const { direction, includesListener } = parsed.data;
          const enhanced = clampCoverDirection(direction);
          return enhanced
            ? { text: enhanced, applied: true, includesListener }
            : { text: input.text, applied: false, includesListener };
        }
      } catch {
        // Enhancement is best-effort; the raw direction is always usable.
      }
      return { text: input.text, applied: false };
    },

    async *streamAssistantReply(input: AssistantReplyInput) {
      assertAllowedBaseUrl(config.providerKey, config.baseUrl);
      const result = streamText({
        model: getModel(),
        instructions: input.system,
        messages: input.messages.map(({ role, content }) => ({ role, content })),
        tools: Object.fromEntries(
          input.tools.map((definition) => [
            definition.name,
            tool({
              description: definition.description,
              inputSchema: definition.inputSchema,
              execute: (toolInput) => definition.execute(toolInput),
            }),
          ]),
        ),
        // One step is one model call. After `maxToolSteps` of them the next
        // call goes out without tools, which leaves the model nothing to do
        // but answer.
        stopWhen: isStepCount(input.maxToolSteps + 1),
        prepareStep: ({ stepNumber }) =>
          stepNumber >= input.maxToolSteps ? { activeTools: [] } : {},
        // The configured timeout bounds one model call, as it does everywhere
        // else in this adapter; a reply is several calls.
        timeout: { stepMs: timeoutMs },
        ...(input.signal ? { abortSignal: input.signal } : {}),
        maxRetries,
        providerOptions: toolCallProviderOptions,
        // The SDK's default handler prints the raw provider error.
        onError: () => {},
      });
      // A model may say something before it calls a tool ("Let me check"). Its
      // answer comes from a later call, so it starts a new paragraph.
      let wroteInEarlierStep = false;
      let wroteInThisStep = false;
      try {
        for await (const part of result.stream) {
          if (part.type === 'text-delta' && part.text) {
            if (wroteInEarlierStep && !wroteInThisStep) yield '\n\n';
            wroteInThisStep = true;
            yield part.text;
          } else if (part.type === 'finish-step') {
            // A provider that stops at its token limit, or withholds the rest,
            // ends the stream cleanly; what arrived is not the whole answer.
            if (part.finishReason === 'length' || part.finishReason === 'content-filter') {
              throw new ProviderError(ASSISTANT_REPLY_CUT_OFF, {
                finishReason: part.finishReason,
              });
            }
            wroteInEarlierStep ||= wroteInThisStep;
            wroteInThisStep = false;
          } else if (part.type === 'error') {
            throw part.error;
          } else if (part.type === 'abort') {
            // The SDK ends an aborted stream without an error, which would pass
            // for a finished answer. It aborts for the caller's signal or for
            // a timeout.
            throw input.signal?.aborted
              ? new ProviderError(ASSISTANT_REPLY_FAILED, { aborted: true })
              : new ProviderError(EXPANSION_TIMED_OUT, { timedOut: true });
          }
        }
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw sanitizedError(err, ASSISTANT_REPLY_FAILED);
      }
    },
  };
  return provider;
}

export function createOpenAiLlmProvider(opts: {
  apiKey: string;
  /** Blank/absent → the well-known default (`gpt-6-luna`); the one preset whose model
   *  is optional, so "OpenAI via API key" works with zero extra configuration. */
  model?: string;
  /** Defaults to `high`. */
  reasoningEffort?: LlmReasoningEffort;
  supportsStructuredOutputs?: boolean;
  baseUrl?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  languageModel?: LanguageModel;
  requestTimeoutMs?: number;
}): LlmProvider {
  const baseUrl = trimTrailingSlash(opts.baseUrl?.trim() || OPENAI_BASE_URL);
  const model = opts.model?.trim() || OPENAI_DEFAULT_LLM_MODEL;
  // The high-effort default is PAIRED with the default model: an explicitly
  // chosen model may not accept `reasoning_effort` (e.g. a non-reasoning model
  // picked to cut cost), and sending it anyway would fail every generation call.
  // An explicit configured effort still applies to any model.
  const reasoningEffort =
    opts.reasoningEffort ??
    (model === OPENAI_DEFAULT_LLM_MODEL ? OPENAI_DEFAULT_REASONING_EFFORT : undefined);
  return createOpenAiCompatibleLlmProvider({
    providerKey: 'openai',
    baseUrl,
    apiKey: opts.apiKey,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    supportsStructuredOutputs: opts.supportsStructuredOutputs ?? false,
    validationBaseUrl: baseUrl,
    ...(opts.headers ? { headers: opts.headers } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.languageModel ? { languageModel: opts.languageModel } : {}),
    ...(opts.requestTimeoutMs != null ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
  });
}

export function createGeminiLlmProvider(opts: {
  apiKey: string;
  /** Blank/absent → the preset default (`gemini-3.8-flash`). */
  model?: string;
  /** Defaults to `low`. */
  reasoningEffort?: LlmReasoningEffort;
  supportsStructuredOutputs?: boolean;
  baseUrl?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  languageModel?: LanguageModel;
  requestTimeoutMs?: number;
}): LlmProvider {
  const baseUrl = trimTrailingSlash(opts.baseUrl?.trim() || GEMINI_BASE_URL);
  // Current Gemini models cannot switch thinking off and refuse `none`;
  // `minimal` is the lowest effort they take.
  const configured = opts.reasoningEffort ?? GEMINI_DEFAULT_REASONING_EFFORT;
  const reasoningEffort = configured === 'none' ? 'minimal' : configured;
  return createOpenAiCompatibleLlmProvider({
    providerKey: 'gemini',
    baseUrl,
    apiKey: opts.apiKey,
    model: opts.model?.trim() || GEMINI_DEFAULT_LLM_MODEL,
    reasoningEffort,
    supportsStructuredOutputs: opts.supportsStructuredOutputs ?? false,
    validationBaseUrl: baseUrl,
    ...(opts.headers ? { headers: opts.headers } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.languageModel ? { languageModel: opts.languageModel } : {}),
    ...(opts.requestTimeoutMs != null ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
  });
}

export function createOpenRouterLlmProvider(opts: {
  apiKey: string;
  model: string;
  /** Same vocabulary as the openai preset; sent as OpenRouter's unified
   *  `reasoning: { effort }`. No default — models vary in reasoning support. */
  reasoningEffort?: LlmReasoningEffort;
  supportsStructuredOutputs?: boolean;
  baseUrl?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  languageModel?: LanguageModel;
  requestTimeoutMs?: number;
}): LlmProvider {
  const baseUrl = trimTrailingSlash(opts.baseUrl?.trim() || OPENROUTER_BASE_URL);
  return createOpenAiCompatibleLlmProvider({
    providerKey: 'openrouter',
    baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
    supportsStructuredOutputs: opts.supportsStructuredOutputs ?? false,
    validationBaseUrl: baseUrl,
    ...(opts.headers ? { headers: opts.headers } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.languageModel ? { languageModel: opts.languageModel } : {}),
    ...(opts.requestTimeoutMs != null ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
  });
}

export function createOllamaLlmProvider(opts: {
  model: string;
  baseUrl?: string;
  supportsStructuredOutputs?: boolean;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  languageModel?: LanguageModel;
  requestTimeoutMs?: number;
  /** Sent only when configured: `none` turns a thinking model's reasoning off. */
  reasoningEffort?: LlmReasoningEffort;
}): LlmProvider {
  // The configured value is the server ROOT (no `/v1`). Generation uses the
  // OpenAI-compatible `/v1` endpoint; credential validation uses the native
  // `/api/tags` route on the root. From a container, Ollama on the same machine is
  // `http://host.docker.internal:11434` (Linux needs
  // `extra_hosts: ["host.docker.internal:host-gateway"]`); other LAN hosts are
  // refused by the SSRF guard.
  const root = trimTrailingSlash(opts.baseUrl?.trim() || OLLAMA_DEFAULT_ROOT);
  return createOpenAiCompatibleLlmProvider({
    providerKey: 'ollama',
    baseUrl: `${root}/v1`,
    model: opts.model,
    supportsStructuredOutputs: opts.supportsStructuredOutputs ?? false,
    validationBaseUrl: root,
    ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.languageModel ? { languageModel: opts.languageModel } : {}),
    ...(opts.requestTimeoutMs != null ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
  });
}
