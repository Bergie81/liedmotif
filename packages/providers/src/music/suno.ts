// Real Suno music-provider adapter. Suno is the one hard-required
// provider type; this is the only file that knows Suno's wire format. It speaks
// the vendor-neutral `MusicProvider` contract so app/worker code never hardcodes
// Suno — selection is wired through `buildMusicProvider`.
//
// Security & money rules baked in here:
//   - The API key rides in the `Authorization` header ONLY and never reaches
//     diagnostics or a thrown error. Every method throws a SANITIZED `ProviderError`
//     (fixed safe text) on transport/HTTP/parse failure — never the raw provider
//     body, the key, or a signed URL.
//   - `createGenerationTask` issues exactly ONE POST and NEVER auto-retries: the
//     worker owns exactly-once submission, and each call spends real money.
//   - `fetch` and `baseUrl` are injectable so the whole adapter is testable with a
//     stub and the test suite makes ZERO real network calls.
//   - Every outbound call is SSRF-gated (`assertAllowedBaseUrl`, like the LLM
//     adapters) and time-bounded: a hung/trickling response aborts to the
//     sanitized `transport` reason instead of pinning a worker slot.
//
// API contract (https://api.sunoapi.org, Bearer auth):
//   POST /api/v1/generate            -> { code, msg, data: { taskId } }
//   GET  /api/v1/generate/record-info?taskId=...
//                                    -> { code, msg, data: { status, response, errorCode, errorMessage, param } }
//   GET  /api/v1/generate/credit     -> { code, msg, data: <number> }
//   POST /api/v1/generate/get-timestamped-lyrics
//                                    -> { code, msg, data: { alignedWords, hootCer, ... } }
// data.status flows PENDING -> TEXT_SUCCESS -> FIRST_SUCCESS -> SUCCESS; failures
// surface either as a non-progress status OR as a populated errorCode/errorMessage
// alongside a still-progress status, so failure detection is field-agnostic.

import { buildProviderDiagnostics } from '@liedmotif/shared';
import {
  ProviderConfigError,
  ProviderError,
  ProviderUnbilledError,
  type UnbilledRefusal,
} from '../errors';
import { assertAllowedBaseUrl } from '../validation/ssrf';
import {
  isDefinitiveRejection,
  isSunoEnvelope,
  nonEmptyString,
  SUNO_DEFAULT_BASE_URL,
  SUNO_DEFAULT_CALLBACK_URL,
  sunoAuthHeaders,
  sunoEnvelopeTaskId,
  sunoFailureCode,
  sunoFetchJson,
  type SunoFetchJsonResult,
} from './suno-wire';
import { createSunoVoiceApi, SUNO_VOICE_PERSONA_MODELS } from './suno-voice';
import type { ProviderValidationResult } from '../types';
import type {
  GenerationCostEstimate,
  MusicFailureReason,
  MusicGenerationInput,
  MusicGenerationStatusResult,
  MusicGenerationTask,
  MusicProvider,
  MusicProviderCapabilities,
  NormalizedTrack,
  ProviderJobStatus,
  TimedLyrics,
  TimedLyricWord,
} from './index';

export interface SunoMusicConfig {
  /** Provider API key (server-side only; sent as `Authorization: Bearer`). */
  apiKey: string;
  /** API base URL; override only for a compatible mirror. */
  baseUrl?: string;
  /**
   * The API REQUIRES a `callBackUrl` even though we poll `record-info`; unset,
   * it is `SUNO_DEFAULT_CALLBACK_URL`.
   */
  callbackUrl?: string;
  /** Model used when an input does not specify one. */
  defaultModel?: string;
  /** Injectable `fetch` — tests pass a stub so no real call is ever made. */
  fetch?: typeof globalThis.fetch;
  /**
   * Per-request timeout (ms) for every outbound call. A provider that accepts the
   * connection but never finishes the body must not pin a worker slot forever.
   */
  requestTimeoutMs?: number;
  /**
   * Delay between lyric-task polls during a user-voice submit (tests pass 0).
   * Lyrics normally land within seconds; the whole wait is capped regardless.
   */
  lyricsPollIntervalMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL = 'V4';

/**
 * Per-model request caps from the provider docs (checked 2026-07-05; V3_5 is no
 * longer offered) — style/title limits differ by model generation, and a request
 * over its model's cap fails the whole submit. Note V4_5ALL's mixed profile.
 * `MODEL_OPTIONS` derives from this table so the two can never drift.
 */
const MODEL_REQUEST_CAPS: Record<string, { maxStyleLength: number; maxTitleLength: number }> = {
  V4: { maxStyleLength: 200, maxTitleLength: 80 },
  V4_5: { maxStyleLength: 1000, maxTitleLength: 100 },
  V4_5PLUS: { maxStyleLength: 1000, maxTitleLength: 100 },
  V4_5ALL: { maxStyleLength: 1000, maxTitleLength: 80 },
  V5: { maxStyleLength: 1000, maxTitleLength: 100 },
  V5_5: { maxStyleLength: 1000, maxTitleLength: 100 },
};

/** Supported sunoapi.org model enums (V4 is the conservative default). */
const MODEL_OPTIONS = Object.keys(MODEL_REQUEST_CAPS);

/** Non-custom `prompt` (a music DESCRIPTION, not lyrics) cap — model-independent. */
const MAX_NON_CUSTOM_PROMPT_LENGTH = 500;

/** Instance-independent capabilities; the per-instance style/title caps (they
 *  depend on the configured default model) are added in `sunoMusicProvider`. */
export const SUNO_BASE_CAPABILITIES: Omit<
  MusicProviderCapabilities,
  'maxStyleLength' | 'maxTitleLength'
> = {
  generationModes: ['non_custom', 'custom'],
  supportsInstrumental: true,
  supportsVocals: true,
  supportsCustomTitle: true,
  supportsStylePrompt: true,
  supportsNegativePrompt: true,
  supportsContinuation: true,
  supportsStreamUrl: true,
  supportsFinalAudioUrl: true,
  typicalTracksPerRequest: 2,
  expectedStreamLatencySeconds: [30, 40],
  expectedFinalLatencySeconds: [120, 180],
  modelOptions: MODEL_OPTIONS,
  // The only `prompt` this adapter ever sends is the non-custom DESCRIPTION —
  // custom-mode prompt would be lyrics, which Liedmotif never has (see
  // `buildRequestBody`).
  maxPromptLength: MAX_NON_CUSTOM_PROMPT_LENGTH,
  providerRetentionNote:
    'Suno retains generated files only temporarily — download and store any saved track.',
};

/** Submit refusal codes (sunoapi.org error table) that clear without any change to the request. */
const SUBMIT_REFUSALS: Readonly<Record<number, UnbilledRefusal>> = {
  405: 'rate_limited',
  429: 'insufficient_credit',
  430: 'rate_limited',
  455: 'provider_unavailable',
};

// Sanitized, fixed user/log-safe messages (never built from a provider response).
const SUBMIT_FAILED = 'The music provider rejected the generation request.';
const STATUS_FAILED = 'Could not read the generation status from the music provider.';
const CREDIT_UNREACHABLE = 'Could not reach the music provider to verify credentials.';
const CREDIT_REJECTED = 'The music provider rejected these credentials.';
const CUSTOM_INSTRUMENTAL_NEEDS_STYLE_TITLE =
  'A custom instrumental generation needs both a style and a title.';
const GENERATION_NEEDS_PROMPT = 'A music generation needs a prompt.';
const LYRICS_TIMING_FAILED = 'Could not read the lyric timing from the music provider.';
const OWN_VOICE_NEEDS_VOCALS = 'A user-voice generation must be a vocal generation.';
const OWN_VOICE_NEEDS_STYLE_TITLE = 'A user-voice generation needs both a style and a title.';
const OWN_VOICE_PROVIDER_UNSUPPORTED =
  'User-voice generation requires the official SunoAPI provider endpoint.';
const LYRICS_WRITE_FAILED = 'The music provider could not write lyrics for this request.';

/** Provider cap on the lyric-brief `prompt` of `POST /api/v1/lyrics`. */
const MAX_LYRICS_BRIEF_LENGTH = 200;
/** Provider cap on custom-mode `prompt` (the literal lyrics) for V5-family models. */
const MAX_CUSTOM_LYRICS_LENGTH = 5000;
const DEFAULT_LYRICS_POLL_INTERVAL_MS = 3_000;
/** Lyric polling is bounded so a stuck lyrics task can never pin a submit
 *  forever. Lyrics normally land within seconds; the whole wait happens inside
 *  a Graphile job slot (1 of 2), so the ceiling is a slot budget (~30 s at the
 *  default interval), not a generous provider timeout. */
const MAX_LYRICS_POLL_ATTEMPTS = 10;

/** Terminal lyric-task statuses from `GET /api/v1/lyrics/record-info`. */
const LYRICS_TASK_SUCCESS = 'SUCCESS';
const LYRICS_TASK_FAILURES = [
  'CREATE_TASK_FAILED',
  'GENERATE_LYRICS_FAILED',
  'CALLBACK_EXCEPTION',
  'SENSITIVE_WORD_ERROR',
];

/**
 * Suno's placeholder `prompt` for instrumental tracks — never lyric text. A custom
 * instrumental submit sends it too: the cover endpoint refuses a music record
 * whose prompt is empty.
 */
const INSTRUMENTAL_PROMPT_PLACEHOLDER = '[Instrumental]';

/** Suno's terminal "in progress / done" statuses mapped to the normalized lifecycle. */
const PROGRESS_STATUS: Record<string, ProviderJobStatus> = {
  PENDING: 'pending',
  TEXT_SUCCESS: 'text_ready',
  FIRST_SUCCESS: 'first_track_ready',
  SUCCESS: 'complete',
};

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Defensive bound on `negativeTags`. The API documents no cap, so this is a
 * self-imposed one: the field is assembled from system terms plus free user
 * Avoid text, and an unbounded string is the kind of input a provider rejects
 * with an opaque error on an otherwise-valid paid submit.
 */
const MAX_NEGATIVE_TAGS_LENGTH = 500;

/** Trim + bound the negative tags, cutting at a comma so no HALF term survives
 *  ("saxophone so" steers differently from the term the user actually wrote).
 *  A single term longer than the bound has no comma to cut at and is hard-cut. */
function clampNegativeTags(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= MAX_NEGATIVE_TAGS_LENGTH) return trimmed;
  const head = trimmed.slice(0, MAX_NEGATIVE_TAGS_LENGTH);
  const lastComma = head.lastIndexOf(',');
  return (lastComma > 0 ? head.slice(0, lastComma) : head).trimEnd();
}

/**
 * Map one Session Guardrail level to the vendor's scale: clamped to [0, 1] and
 * rounded to the 0.01 increments the API takes. The contract already validated
 * user input, so this guards programmer error — and a non-finite number carries
 * no level at all, so it sends nothing rather than a made-up bound.
 */
function steeringLevel(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

/**
 * The steering fields every generate body carries — what to avoid, plus the
 * Session Guardrails under Suno's own names (`styleWeight` for how strictly the
 * style is honored, `weirdnessConstraint` for how far the model may deviate).
 * An ABSENT level sends no key at all: a session created before guardrails
 * existed must not acquire one here, or its Dislike rerolls stop matching the
 * tracks they sit beside.
 */
function steeringFields(input: MusicGenerationInput): Record<string, unknown> {
  const negativeTags = clampNegativeTags(input.negativeTags);
  const styleWeight = steeringLevel(input.styleStrength);
  const weirdnessConstraint = steeringLevel(input.novelty);
  return {
    ...(negativeTags ? { negativeTags } : {}),
    ...(styleWeight !== undefined ? { styleWeight } : {}),
    ...(weirdnessConstraint !== undefined ? { weirdnessConstraint } : {}),
  };
}

/** Known provider failure tokens that map to `generation_failed`, matched in ANY field. */
const GENERATION_FAILED_TOKENS = [
  'generate_audio_failed',
  'audio_failed',
  'create_task_failed',
  'callback_exception',
];

/**
 * Map a failed job to a sanitized reason, FIELD-AGNOSTICALLY: Suno may carry the
 * failure token in `status`, `errorCode`, or `errorMessage`, so we match against a
 * combined lowercased blob rather than `status` alone. Credit and sensitive checks
 * keep priority; unrecognized failures fall back to `unknown`.
 */
function mapFailureReason(raw: SunoRecordInfoData): MusicFailureReason {
  const blob = `${raw.status ?? ''} ${raw.errorCode ?? ''} ${raw.errorMessage ?? ''}`.toLowerCase();
  // Credit exhaustion is the most actionable signal — check it first.
  if (blob.includes('credit')) return 'insufficient_credit';
  if (raw.status === 'SENSITIVE_WORD_ERROR' || blob.includes('sensitive'))
    return 'sensitive_content';
  if (GENERATION_FAILED_TOKENS.some((token) => blob.includes(token))) return 'generation_failed';
  return 'unknown';
}

interface SunoRecordInfoData {
  status?: string;
  response?: { sunoData?: unknown[] } | null;
  errorCode?: unknown;
  errorMessage?: unknown;
  param?: unknown;
}

/**
 * Whether a record-info payload carries a GENUINELY-POPULATED hard-error signal —
 * used to force `failed` even when `status` is still a progress value. The guard is
 * deliberately strict so a normal in-progress/success payload is NEVER misread as
 * failed: an absent/null/empty error field, or a `0` / `200` / `success` errorCode
 * with no errorMessage, is NOT a failure.
 */
function hasHardError(raw: SunoRecordInfoData): boolean {
  // A non-empty errorMessage is itself a populated failure signal.
  if (typeof raw.errorMessage === 'string' && raw.errorMessage.trim() !== '') return true;

  const code = raw.errorCode;
  if (typeof code === 'number') return code !== 0 && code !== 200;
  if (typeof code === 'string') {
    const normalized = code.trim().toLowerCase();
    return (
      normalized !== '' && normalized !== '0' && normalized !== '200' && normalized !== 'success'
    );
  }
  return false; // absent / null / other -> not a failure
}

/** Best-effort, non-secret requested model from the echoed-back `param` JSON string. */
function requestedModelFromParam(param: unknown): string | undefined {
  if (typeof param !== 'string') return undefined;
  try {
    const model = (JSON.parse(param) as { model?: unknown }).model;
    return typeof model === 'string' ? model : undefined;
  } catch {
    return undefined;
  }
}

export function sunoMusicProvider(config: SunoMusicConfig): MusicProvider {
  const apiKey = config.apiKey;
  const baseUrl = trimTrailingSlash(config.baseUrl?.trim() || SUNO_DEFAULT_BASE_URL);
  const callbackUrl = config.callbackUrl?.trim() || SUNO_DEFAULT_CALLBACK_URL;
  const defaultModel = config.defaultModel?.trim() || DEFAULT_MODEL;
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const lyricsPollIntervalMs = config.lyricsPollIntervalMs ?? DEFAULT_LYRICS_POLL_INTERVAL_MS;
  const supportsVoiceWorkflow = baseUrl === SUNO_DEFAULT_BASE_URL;

  // Fail fast at construction on an unknown DEFAULT model (e.g. a stale env value
  // for a model the provider no longer offers) — a clear boot-time config error
  // beats an opaque failure on the first paid submit. Per-INPUT models are still
  // validated on every createGenerationTask call.
  const defaultModelCaps = MODEL_REQUEST_CAPS[defaultModel];
  if (!defaultModelCaps) {
    throw new ProviderConfigError(
      `Unsupported default music model. Choose one of: ${MODEL_OPTIONS.join(', ')}.`,
    );
  }
  // The advertised style/title caps are the CONFIGURED default model's (what an
  // input without an explicit model gets): the compile step budgets its output
  // against these so the informative tail (variation, BPM/key) survives, while
  // `buildRequestBody` still clamps to the actual per-request model's caps.
  // `customVoice.supported` needs only the voice workflow: an own-voice submit
  // pins the persona model itself, so the configured default model never
  // decides whether "Use my voice" is offered — nor the style cap an own-voice
  // compile budgets against.
  const capabilities: MusicProviderCapabilities = {
    ...SUNO_BASE_CAPABILITIES,
    ...defaultModelCaps,
    customVoice: {
      supported: supportsVoiceWorkflow,
      maxVoicesPerGeneration: 1,
      requiresVerificationPhrase: true,
      supportedModels: [...SUNO_VOICE_PERSONA_MODELS],
      maxStyleLength: MODEL_REQUEST_CAPS[SUNO_VOICE_PERSONA_MODELS[0]!]!.maxStyleLength,
    },
  };

  function authHeaders(extra?: Record<string, string>): Record<string, string> {
    return sunoAuthHeaders(apiKey, extra);
  }

  /** Issue one request and return its parsed JSON, or a sanitized failure reason. */
  function fetchJson(url: string, init: RequestInit): Promise<SunoFetchJsonResult> {
    return sunoFetchJson(fetchImpl, url, init, requestTimeoutMs);
  }

  /** Map one raw `sunoData` item to a normalized track (see the interface contract). */
  function normalizeTrack(raw: unknown): NormalizedTrack {
    const track = (raw ?? {}) as {
      id?: unknown;
      title?: unknown;
      streamAudioUrl?: unknown;
      audioUrl?: unknown;
      duration?: unknown;
      modelName?: unknown;
      prompt?: unknown;
    };
    const streamAudioUrl = nonEmptyString(track.streamAudioUrl);
    // audioUrl is "" until the final asset is ready — treat "" as ABSENT.
    const audioUrl = nonEmptyString(track.audioUrl);
    // `prompt` is the track's sung lyrics on a vocal generation; the instrumental
    // placeholder is vendor filler, not lyric text.
    const lyrics = nonEmptyString(track.prompt);
    return {
      providerTrackId: String(track.id ?? ''),
      ...(typeof track.title === 'string' ? { title: track.title } : {}),
      ...(streamAudioUrl ? { streamAudioUrl } : {}),
      ...(audioUrl ? { audioUrl } : {}),
      // duration is null until SUCCESS — treat null/non-number as ABSENT.
      ...(typeof track.duration === 'number' ? { durationSeconds: track.duration } : {}),
      ...(typeof track.modelName === 'string' ? { model: track.modelName } : {}),
      ...(lyrics && lyrics !== INSTRUMENTAL_PROMPT_PLACEHOLDER ? { lyrics } : {}),
    };
  }

  /** Trim + truncate a field to its provider cap; empty/absent stays undefined. */
  function clampField(value: string | undefined, maxLength: number): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed.slice(0, maxLength) : undefined;
  }

  /**
   * Write the lyrics a user-voice (persona) generation must carry: persona
   * fields are custom-mode-only, custom-mode vocals require LITERAL lyrics, and
   * Liedmotif never authors lyrics itself (the text LLM is optional and never
   * per-track) — so the provider's own lyrics endpoint writes them
   * from the compiled description. Submit → poll → first usable text. Every
   * failure (transport, task failure, timeout, no text) throws the same
   * sanitized error BEFORE the paid generate POST goes out. The lyrics call
   * itself costs a small number of credits; the wait is attempt-capped so a
   * stuck lyrics task can never pin a worker slot.
   */
  async function generateLyricsText(brief: string): Promise<string> {
    const prompt = clampField(brief, MAX_LYRICS_BRIEF_LENGTH);
    if (!prompt) throw new ProviderConfigError(GENERATION_NEEDS_PROMPT);
    const submit = await fetchJson(`${baseUrl}/api/v1/lyrics`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ prompt, callBackUrl: callbackUrl }),
      redirect: 'manual',
    });
    const taskId = submit.ok ? extractTaskId(submit.payload) : undefined;
    if (!taskId) {
      // A definitively refused lyrics submit created no task, and the paid
      // generate POST never goes out, so nothing was charged.
      if (!isDefinitiveRejection(submit)) throw new ProviderError(LYRICS_WRITE_FAILED);
      const code = sunoFailureCode(submit);
      throw new ProviderUnbilledError(
        LYRICS_WRITE_FAILED,
        undefined,
        code == null ? undefined : SUBMIT_REFUSALS[code],
      );
    }

    for (let attempt = 0; attempt < MAX_LYRICS_POLL_ATTEMPTS; attempt += 1) {
      if (attempt > 0 && lyricsPollIntervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, lyricsPollIntervalMs));
      }
      const result = await fetchJson(
        `${baseUrl}/api/v1/lyrics/record-info?taskId=${encodeURIComponent(taskId)}`,
        { method: 'GET', headers: authHeaders(), redirect: 'manual' },
      );
      if (!result.ok) throw new ProviderError(LYRICS_WRITE_FAILED);
      const payload = result.payload;
      if (!isSunoEnvelope(payload) || payload.code !== 200) {
        throw new ProviderError(LYRICS_WRITE_FAILED);
      }
      const data = (payload.data ?? {}) as {
        status?: unknown;
        response?: { data?: unknown[] } | null;
      };
      const status = typeof data.status === 'string' ? data.status : '';
      if (LYRICS_TASK_FAILURES.includes(status)) throw new ProviderError(LYRICS_WRITE_FAILED);
      if (status !== LYRICS_TASK_SUCCESS) continue;
      const items = Array.isArray(data.response?.data) ? data.response.data : [];
      for (const raw of items) {
        const item = (raw ?? {}) as { text?: unknown; status?: unknown };
        const text = nonEmptyString(item.text);
        if (text && item.status !== 'failed') return text.slice(0, MAX_CUSTOM_LYRICS_LENGTH);
      }
      throw new ProviderError(LYRICS_WRITE_FAILED);
    }
    throw new ProviderError(LYRICS_WRITE_FAILED);
  }

  /**
   * Compose the lyrics-writing brief within the provider's cap. The language
   * directive LEADS and always survives the clamp (it is the difference between
   * lyrics in the session language and English ones); the theme is the lyric
   * direction when the input carries one, else the compiled description.
   * Undefined when there is no theme at all — the caller's lyrics call then
   * rejects it as a missing prompt.
   */
  function buildLyricsBrief(input: MusicGenerationInput): string | undefined {
    const language = input.language?.trim();
    const directive = language ? `Write the lyrics in ${language}. ` : '';
    const theme = input.lyricBrief?.trim() || input.prompt?.trim();
    if (!theme) return undefined;
    return (directive + theme).slice(0, MAX_LYRICS_BRIEF_LENGTH);
  }

  /**
   * Build the user-voice (persona) request body: custom mode with the written
   * lyrics as `prompt` and the voice reference as `personaId`. All input
   * validation happens in `createGenerationTask` BEFORE the lyrics call, so an
   * invalid request spends nothing.
   */
  function buildOwnVoiceRequestBody(
    input: MusicGenerationInput,
    model: string,
    fields: { style: string; title: string; providerVoiceId: string },
    lyrics: string,
  ): Record<string, unknown> {
    return {
      customMode: true,
      instrumental: false,
      model,
      callBackUrl: callbackUrl,
      style: fields.style,
      title: fields.title,
      prompt: lyrics,
      personaId: fields.providerVoiceId,
      personaModel: 'voice_persona',
      ...steeringFields(input),
    };
  }

  /** Build the vendor request body. Throws (no network) on an invalid request. */
  function buildRequestBody(input: MusicGenerationInput, model: string): Record<string, unknown> {
    // The caller validated `model`, so the caps lookup always hits.
    const caps = MODEL_REQUEST_CAPS[model]!;
    if (input.mode === 'custom' && input.instrumental) {
      // Clamp AFTER every compiled suffix is already in place: an over-long
      // style/title loses tail detail here instead of failing the whole submit on
      // a provider length cap (with only an opaque sanitized error to show for it).
      const style = clampField(input.style, caps.maxStyleLength);
      const title = clampField(input.title, caps.maxTitleLength);
      // Per the provider, a custom INSTRUMENTAL generation requires style AND title.
      if (!style || !title) {
        throw new ProviderConfigError(CUSTOM_INSTRUMENTAL_NEEDS_STYLE_TITLE);
      }
      return {
        customMode: true,
        instrumental: true,
        model,
        callBackUrl: callbackUrl,
        style,
        title,
        prompt: INSTRUMENTAL_PROMPT_PLACEHOLDER,
        ...steeringFields(input),
      };
    }
    // Non-custom mode — ALSO the path for every VOCAL request, even a `mode:
    // 'custom'` input: Suno's custom-mode `prompt` is strictly the LYRICS, while
    // the contract's `prompt` is a style DESCRIPTION, so a custom vocal submit
    // would make the track literally sing the style prompt. Liedmotif has no lyrics
    // source (the text LLM is optional and never per-track), so vocal
    // generations go non-custom and the provider writes its own lyrics from the
    // description. Style/title are custom-mode-only fields and stay unsent.
    const prompt = clampField(input.prompt, MAX_NON_CUSTOM_PROMPT_LENGTH);
    if (!prompt) throw new ProviderConfigError(GENERATION_NEEDS_PROMPT);
    return {
      customMode: false,
      prompt,
      instrumental: input.instrumental,
      model,
      callBackUrl: callbackUrl,
      ...steeringFields(input),
    };
  }

  return {
    providerType: 'music',
    providerKey: 'suno',

    getCapabilities(): MusicProviderCapabilities {
      return capabilities;
    },

    // The upload service is tied to api.sunoapi.org credentials. A compatible
    // mirror may implement music generation, but its key must never be sent to
    // SunoAPI's separate upload host.
    ...(supportsVoiceWorkflow
      ? {
          voice: createSunoVoiceApi({
            apiKey,
            callbackUrl,
            fetch: fetchImpl,
            requestTimeoutMs,
          }),
        }
      : {}),

    estimateGenerationCost(_input: MusicGenerationInput): GenerationCostEstimate {
      // Pure: one provider call yields two tracks. Credit cost varies by model, so
      // it is deliberately left undefined here rather than hardcoded.
      const providerCalls = 1;
      return {
        providerCalls,
        expectedTracks: providerCalls * capabilities.typicalTracksPerRequest,
      };
    },

    async createGenerationTask(input: MusicGenerationInput): Promise<MusicGenerationTask> {
      // SSRF gate before any outbound call, mirroring the LLM adapters: a
      // configurable base URL must never reach a private/metadata host with the
      // Bearer key attached. Throws a sanitized config error (no network).
      assertAllowedBaseUrl('suno', baseUrl);
      const requestedModel = input.model?.trim() || defaultModel;
      // Validate the model BEFORE spending money: an unknown model is a sanitized,
      // no-network rejection (the message lists the valid options, never a secret).
      if (!MODEL_OPTIONS.includes(requestedModel)) {
        throw new ProviderConfigError(
          `Unsupported music model. Choose one of: ${MODEL_OPTIONS.join(', ')}.`,
        );
      }
      // An own-voice request PINS the persona model: Suno honors cloned voices
      // only there (Voices FAQ), and any other model would silently sing with a
      // generic voice — the exact fallback the own-voice contract forbids. The
      // configured/requested model keeps governing every other request.
      const model = input.customVoice ? SUNO_VOICE_PERSONA_MODELS[0]! : requestedModel;
      let body: Record<string, unknown>;
      if (input.customVoice) {
        // Persona generation is custom-mode-only and vocal-only. Everything is
        // validated BEFORE any network call.
        if (!supportsVoiceWorkflow) {
          throw new ProviderConfigError(OWN_VOICE_PROVIDER_UNSUPPORTED);
        }
        if (input.instrumental) throw new ProviderConfigError(OWN_VOICE_NEEDS_VOCALS);
        const caps = MODEL_REQUEST_CAPS[model]!;
        const style = clampField(input.style, caps.maxStyleLength);
        const title = clampField(input.title, caps.maxTitleLength);
        if (!style || !title) throw new ProviderConfigError(OWN_VOICE_NEEDS_STYLE_TITLE);
        // The cheap lyrics call runs first (see `generateLyricsText`); the paid
        // generate POST below still goes out exactly once. Its credits are spent
        // the moment it succeeds — which is why an own-voice submit can never
        // report itself unbilled below, however the generate POST is rejected.
        const lyrics = await generateLyricsText(buildLyricsBrief(input) ?? '');
        body = buildOwnVoiceRequestBody(
          input,
          model,
          { style, title, providerVoiceId: input.customVoice.providerVoiceId },
          lyrics,
        );
      } else {
        body = buildRequestBody(input, model); // may throw a sanitized config error (no network)
      }

      const result = await fetchJson(`${baseUrl}/api/v1/generate`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
        redirect: 'manual',
      });
      // Any transport/HTTP/parse failure, or a response without a taskId, is the
      // same sanitized submit failure — the raw provider error is never
      // surfaced. What differs is the ACCOUNTING: a definitive rejection proves
      // no task was created and so nothing was charged. An own-voice submit is
      // never unbilled however its generate POST is rejected: its lyrics call
      // has already spent credits by here.
      const taskId = result.ok ? extractTaskId(result.payload) : undefined;
      if (!result.ok || !taskId) {
        const unbilled = !input.customVoice && isDefinitiveRejection(result);
        if (!unbilled) throw new ProviderError(SUBMIT_FAILED);
        const code = sunoFailureCode(result);
        throw new ProviderUnbilledError(
          SUBMIT_FAILED,
          undefined,
          code == null ? undefined : SUBMIT_REFUSALS[code],
        );
      }

      return {
        providerTaskId: taskId,
        status: 'pending',
        provider: { providerType: 'music', providerKey: 'suno', model },
        diagnostics: buildProviderDiagnostics({ rawRequest: body, rawResponse: result.payload }),
      };
    },

    async getGenerationStatus(providerTaskId: string): Promise<MusicGenerationStatusResult> {
      assertAllowedBaseUrl('suno', baseUrl); // SSRF gate before any outbound call
      const url = `${baseUrl}/api/v1/generate/record-info?taskId=${encodeURIComponent(providerTaskId)}`;

      const result = await fetchJson(url, {
        method: 'GET',
        headers: authHeaders(),
        redirect: 'manual',
      });
      if (!result.ok) throw new ProviderError(STATUS_FAILED);

      // A code other than 200 means the status CALL itself failed (bad task id /
      // auth), distinct from a failed JOB — that is a transport-level error.
      const payload = result.payload;
      if (!isSunoEnvelope(payload) || payload.code !== 200) throw new ProviderError(STATUS_FAILED);

      const data = (payload.data ?? {}) as SunoRecordInfoData;
      const tracks = Array.isArray(data.response?.sunoData)
        ? data.response.sunoData.map(normalizeTrack)
        : [];
      const model = requestedModelFromParam(data.param);
      const provider = {
        providerType: 'music' as const,
        providerKey: 'suno',
        ...(model ? { model } : {}),
      };

      const lifecycle = data.status ? PROGRESS_STATUS[data.status] : undefined;
      // A populated hard error forces `failed` even if `status` is still a progress
      // value (Suno may report the failure only in errorCode/errorMessage). A normal
      // in-progress/success payload (no hard error) keeps its lifecycle.
      if (lifecycle && !hasHardError(data)) return { status: lifecycle, tracks, provider };
      // `code: 200` with NO status and NO hard error is a malformed or racing status
      // READ (e.g. record-info racing task creation), not a failed job — throw the
      // retryable call failure instead of abandoning an already-paid task.
      if (!nonEmptyString(data.status) && !hasHardError(data)) {
        throw new ProviderError(STATUS_FAILED);
      }
      // Non-progress status OR a progress status carrying a hard error — a failed JOB.
      // Return it, never throw.
      return { status: 'failed', tracks, provider, failureReason: mapFailureReason(data) };
    },

    async validateCredentials(): Promise<ProviderValidationResult> {
      try {
        assertAllowedBaseUrl('suno', baseUrl);
      } catch (err) {
        // Validation reports rather than throws (mirrors the LLM adapters).
        if (err instanceof ProviderConfigError) return { ok: false, message: err.message };
        throw err;
      }
      const result = await fetchJson(`${baseUrl}/api/v1/generate/credit`, {
        method: 'GET',
        headers: authHeaders(),
        redirect: 'manual',
      });
      // Only an unreachable provider is "couldn't verify"; an HTTP/parse failure is
      // a credential rejection.
      if (!result.ok) {
        const message = result.reason === 'transport' ? CREDIT_UNREACHABLE : CREDIT_REJECTED;
        return { ok: false, message };
      }
      const payload = result.payload;
      if (isSunoEnvelope(payload) && payload.code === 200 && typeof payload.data === 'number') {
        return {
          ok: true,
          balance: payload.data,
          message: `Music provider reachable; ${payload.data} credits available.`,
        };
      }
      return { ok: false, message: CREDIT_REJECTED };
    },

    normalizeProviderTrack(raw: unknown): NormalizedTrack {
      return normalizeTrack(raw);
    },

    async getTimestampedLyrics(input): Promise<TimedLyrics | null> {
      assertAllowedBaseUrl('suno', baseUrl); // SSRF gate before any outbound call
      const result = await fetchJson(`${baseUrl}/api/v1/generate/get-timestamped-lyrics`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ taskId: input.providerTaskId, audioId: input.providerTrackId }),
        redirect: 'manual',
      });
      if (!result.ok) throw new ProviderError(LYRICS_TIMING_FAILED);
      const payload = result.payload;
      if (!isSunoEnvelope(payload) || payload.code !== 200) {
        throw new ProviderError(LYRICS_TIMING_FAILED);
      }
      // A successful call without aligned words means the provider has no timing
      // for this track (e.g. retention expired) — that is data, not a failure.
      const data = (payload.data ?? {}) as { alignedWords?: unknown; hootCer?: unknown };
      if (!Array.isArray(data.alignedWords) || data.alignedWords.length === 0) return null;
      const words = data.alignedWords.flatMap((raw): TimedLyricWord[] => {
        const item = (raw ?? {}) as {
          word?: unknown;
          startS?: unknown;
          endS?: unknown;
          success?: unknown;
        };
        if (typeof item.word !== 'string') return [];
        if (typeof item.startS !== 'number' || typeof item.endS !== 'number') return [];
        return [
          {
            word: item.word,
            startSeconds: item.startS,
            endSeconds: item.endS,
            success: item.success !== false,
          },
        ];
      });
      if (words.length === 0) return null;
      return {
        words,
        alignmentErrorScore: typeof data.hootCer === 'number' ? data.hootCer : null,
      };
    },
  };
}

/** Pull `data.taskId` from a SUCCESSFUL submit response (envelope code 200). */
function extractTaskId(payload: unknown): string | undefined {
  if (!isSunoEnvelope(payload) || payload.code !== 200) return undefined;
  return sunoEnvelopeTaskId(payload);
}
