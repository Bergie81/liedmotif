// Music provider interface (the one hard-required provider type).
//
// Callers speak in capabilities and normalized shapes, never in vendor fields, so
// Suno can be swapped for another music model without touching app logic.
// Continuation/extension is REPORTED via capabilities but the app
// exposes no extend flow, so there is deliberately no `extend*` method here.

import type { TimedLyrics } from '@liedmotif/shared';
import type { BaseProvider, ProviderDiagnostics, ProviderMetadata } from '../types';

export type MusicGenerationMode = 'non_custom' | 'custom';

/**
 * Whether (and under which models) the provider can sing with a user-created
 * voice profile. `supported` reflects the CONFIGURED endpoint and default
 * model — the pre-spend gate callers check — while `supportedModels` names the
 * full set so a per-input model override is still validated inside the adapter.
 */
export interface MusicCustomVoiceCapability {
  supported: boolean;
  /** Current providers accept a single voice reference per generation. */
  maxVoicesPerGeneration: number;
  /** Whether voice setup requires the user to record a provider-issued phrase. */
  requiresVerificationPhrase: boolean;
  supportedModels?: string[];
  /** Style cap of the model an own-voice submit uses — what an own-voice
   *  compile budgets against; absent means the default `maxStyleLength`. */
  maxStyleLength?: number;
}

/** What a music adapter can do, so callers never branch on the vendor name. */
export interface MusicProviderCapabilities {
  generationModes: MusicGenerationMode[];
  supportsInstrumental: boolean;
  supportsVocals: boolean;
  supportsCustomTitle: boolean;
  supportsStylePrompt: boolean;
  supportsNegativePrompt: boolean;
  /** Whether the provider can extend/continue a track (reported, not used). */
  supportsContinuation: boolean;
  supportsStreamUrl: boolean;
  supportsFinalAudioUrl: boolean;
  /** Tracks produced per provider job (2 for Suno). */
  typicalTracksPerRequest: number;
  /** Inclusive [min, max] seconds until the early stream URL is usable. */
  expectedStreamLatencySeconds?: [number, number];
  /** Inclusive [min, max] seconds until the final audio asset is ready. */
  expectedFinalLatencySeconds?: [number, number];
  modelOptions: string[];
  /** Style/title caps for the DEFAULT request (the adapter's configured default
   *  model) — what a compile step should budget against. NOT the maximum across
   *  `modelOptions`; per-request model caps are enforced inside the adapter. */
  maxStyleLength?: number;
  maxTitleLength?: number;
  maxPromptLength?: number;
  /** How long the provider retains generated files (download-and-store reminder). */
  providerRetentionNote?: string;
  /** Custom user-voice support; absent means the provider has none. */
  customVoice?: MusicCustomVoiceCapability;
}

/** Vendor-neutral input for one provider job, compiled from a Style Snapshot. */
export interface MusicGenerationInput {
  mode: MusicGenerationMode;
  /**
   * The compiled track DESCRIPTION (the only required field in non-custom mode).
   * It is never lyrics — an adapter must not submit it anywhere the vendor expects
   * lyric text.
   */
  prompt: string;
  /** Custom-mode style (the compiled Style Snapshot style). */
  style?: string;
  /** Cosmetic custom-mode title; never blocks submission. */
  title?: string;
  instrumental: boolean;
  /** Negative tags/terms to steer away from (capability-gated). */
  negativeTags?: string;
  /**
   * The Session Guardrails as provider-neutral 0–1 levels: how
   * strictly to honor `style`, and how far the model may
   * deviate into the experimental. Each adapter maps them to its own vendor
   * parameter. Absent means the session was created before guardrails existed —
   * an adapter must then send nothing, not a default, so the take still matches
   * the tracks it is generated alongside.
   */
  styleStrength?: number;
  novelty?: number;
  /** Provider model option; unset means the adapter's configured default model. */
  model?: string;
  /**
   * Hidden per-track seed (advisory). Providers without a native seed field ignore
   * it — its audible effect reaches them via the seed-derived variation the
   * template folds into `prompt`/`style`.
   */
  seed?: number;
  /**
   * Sing with the user's own voice profile (vocal generations only). The
   * orchestration layer resolves the app-side profile to this provider voice
   * reference before calling the adapter; the adapter maps it to vendor fields.
   * There is NEVER a silent fallback: an adapter that cannot honor it must
   * throw a sanitized error before spending.
   */
  customVoice?: { providerVoiceId: string };
  /**
   * The session language (canonical English name, e.g. "German"). An adapter
   * that writes LITERAL lyrics (user-voice custom mode) needs it explicitly —
   * the compiled description is English by contract, so the language signal
   * buried in it does not survive a lyrics-brief clamp.
   */
  language?: string;
  /**
   * The session's compact lyric direction (the Style Snapshot's lyricContext),
   * for the same literal-lyrics path — it, not the instrument description, is
   * what the lyrics should be about.
   */
  lyricBrief?: string;
}

/**
 * Cost of a generation request. Spend is counted internally in provider calls
 * (tasks) but always reported to the user in tracks, so both are
 * carried here and the conversion lives in one place.
 */
export interface GenerationCostEstimate {
  /** Provider calls (tasks) — the unit cost limits count against. */
  providerCalls: number;
  /** Tracks the request will yield (providerCalls × typicalTracksPerRequest). */
  expectedTracks: number;
  /** Provider credits if computable (non-secret), else undefined. */
  estimatedCredits?: number;
}

/** Normalized provider-job lifecycle, mapped from each vendor's own status flow. */
export type ProviderJobStatus =
  'pending' | 'text_ready' | 'first_track_ready' | 'complete' | 'failed';

/** Sanitized failure category — never the raw provider error text. */
export type MusicFailureReason =
  'generation_failed' | 'sensitive_content' | 'insufficient_credit' | 'unknown';

/**
 * One normalized track — a Sibling Track. The audio URLs are SERVER-SIDE ONLY:
 * they are proxied/downloaded by app routes and must never reach the browser or
 * the logs (the diagnostics redactor strips them).
 */
export interface NormalizedTrack {
  /** Stable id of this track within its provider job. */
  providerTrackId: string;
  /** Cosmetic title; may be empty — never blocks playback or buffering. */
  title?: string;
  /** Early stream URL (server-side proxy source). */
  streamAudioUrl?: string;
  /** Final downloadable URL (downloaded, stored, then served via app route). */
  audioUrl?: string;
  durationSeconds?: number;
  model?: string;
  /**
   * The sung lyric text the provider reports for this track. Meaningful only for
   * VOCAL generations — persistence must gate on the request's vocal mode, since
   * the adapter has no input context at poll time and instrumental payloads may
   * still carry filler text.
   */
  lyrics?: string;
}

// Word-level lyric timing is the shared `TimedLyrics` shape — one definition
// for adapters, persistence, and line grouping alike.
export type { TimedLyricWord, TimedLyrics } from '@liedmotif/shared';

/** Handle to a submitted provider job. `providerTaskId` must be persisted at once. */
export interface MusicGenerationTask {
  providerTaskId: string;
  status: ProviderJobStatus;
  provider: ProviderMetadata;
  diagnostics?: ProviderDiagnostics;
}

// --- Voice profiles (custom user voice) ---------------------------------------

/** One recording handed to the provider's voice workflow, as raw bytes — the
 *  adapter owns delivery (e.g. a temporary provider upload), so no Liedmotif
 *  storage URL ever leaves the server. */
export interface VoiceAudioSource {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
}

/** Normalized voice-setup task lifecycle (validation and creation alike). */
export type VoiceSetupStatus = 'processing' | 'complete' | 'failed';

export interface VoiceValidationStatusResult {
  status: VoiceSetupStatus;
  /** The provider-issued phrase the user must record; set once `complete`. */
  verificationPhrase?: string;
  /** Sanitized failure category; set only when `status === 'failed'`. */
  failureReason?: MusicFailureReason;
}

export interface VoiceCreationStatusResult {
  status: VoiceSetupStatus;
  /** The provider voice reference used for generation; set once `complete`. */
  providerVoiceId?: string;
  /** Sanitized failure category; set only when `status === 'failed'`. */
  failureReason?: MusicFailureReason;
}

/**
 * The provider's voice-profile setup workflow (OPTIONAL — presence is the
 * capability, alongside `capabilities.customVoice`). Submits throw SANITIZED
 * errors on failure; status polls are free and side-effect-less. Both submit
 * calls may cost provider credits, so callers persist the returned task id
 * immediately, like `createGenerationTask`.
 */
export interface MusicVoiceApi {
  /** Submit a source recording for validation; returns the validation task. */
  validateSource(input: {
    audio: VoiceAudioSource;
    vocalStartS: number;
    vocalEndS: number;
    /** Provider language hint (e.g. 'en'); omitted lets the provider decide. */
    language?: string;
  }): Promise<{ providerTaskId: string }>;
  /** Poll a validation task until the verification phrase is available. */
  getValidationStatus(providerTaskId: string): Promise<VoiceValidationStatusResult>;
  /** Submit the recorded verification phrase; returns the creation task. */
  createVoice(input: {
    validationTaskId: string;
    audio: VoiceAudioSource;
  }): Promise<{ providerTaskId: string }>;
  /** Poll a creation task until the provider voice reference is available. */
  getVoiceStatus(providerTaskId: string): Promise<VoiceCreationStatusResult>;
}

/** Status poll result: lifecycle plus any normalized sibling tracks available so far. */
export interface MusicGenerationStatusResult {
  status: ProviderJobStatus;
  tracks: NormalizedTrack[];
  provider: ProviderMetadata;
  diagnostics?: ProviderDiagnostics;
  /** Set only when `status === 'failed'`. */
  failureReason?: MusicFailureReason;
}

export interface MusicProvider extends BaseProvider {
  readonly providerType: 'music';
  getCapabilities(): MusicProviderCapabilities;
  /** Pure, synchronous cost estimate (no network) for pre-spend limit checks. */
  estimateGenerationCost(input: MusicGenerationInput): GenerationCostEstimate;
  /**
   * Submit one provider job; the returned `providerTaskId` must be persisted
   * immediately. Throws a SANITIZED error on submission failure (never the raw
   * provider error) — a job that fails after submission surfaces via
   * `getGenerationStatus` with `status: 'failed'` and a `failureReason` instead.
   */
  createGenerationTask(input: MusicGenerationInput): Promise<MusicGenerationTask>;
  /** Poll a provider job for its normalized status and any tracks ready so far. */
  getGenerationStatus(providerTaskId: string): Promise<MusicGenerationStatusResult>;
  /** Map a single raw provider track object to the normalized shape. */
  normalizeProviderTrack(raw: unknown): NormalizedTrack;
  /**
   * Word-level lyric timing for one generated track (OPTIONAL — presence is the
   * capability). Returns null when the provider has no timing for the track;
   * throws a SANITIZED error when the call itself fails. May cost provider
   * credits — callers cache the result and fetch at most once per track.
   */
  getTimestampedLyrics?(input: {
    providerTaskId: string;
    providerTrackId: string;
  }): Promise<TimedLyrics | null>;
  /**
   * Voice-profile setup workflow (OPTIONAL — presence is the capability, and
   * `capabilities.customVoice` gates whether GENERATION can use the result).
   */
  voice?: MusicVoiceApi;
}
