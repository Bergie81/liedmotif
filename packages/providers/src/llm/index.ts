// Text-LLM provider interface (the prompt expander).
//
// The text LLM is OPTIONAL: it produces the Style Snapshot ONLY for the
// free-text/voice create path. Structured controls compile to the same snapshot
// shape via a deterministic template (`./template`) with no LLM — so the music
// path (the one hard-required provider) never depends on a configured LLM. Title/artist metadata
// is cosmetic and must never block playback, buffering, or provider submission.

import type { BaseProvider } from '../types';
import type { EnergyLevel, SessionStyleSnapshot } from './snapshot';
import type { SessionNamingMetadata } from './session-title';
import type { StylePicks, TrackMetadata } from './template';
import type {
  ExpansionOptions,
  SessionNamingInput,
  SurpriseRequestInput,
  TrackLyricBriefInput,
  TrackTitlesInput,
} from './session-prompts';

export type {
  ExpansionOptions,
  SessionNamingInput,
  SurpriseRequestInput,
  TrackLyricBriefInput,
  TrackTitlesInput,
};

/** A Surprise Me request as the listener might have typed it. */
export interface SurpriseRequest {
  request: string;
  energy: EnergyLevel;
  /** How long the situation lasts, 10–60 in steps of 5. */
  durationMinutes: number;
}

export interface LlmProviderCapabilities {
  /** Whether strict structured outputs (vs JSON + Zod safeParse) are supported. */
  supportsStructuredOutputs: boolean;
  model: string;
}

export interface ExpandedSessionIntent {
  /** Explicit requested total, validated by the Session creator after control precedence. */
  requestedDurationMinutes?: number | null;
  snapshot: SessionStyleSnapshot;
  coverConcept: string;
}

/** User-written cover art direction plus its safe, non-personal context. */
export interface CoverDirectionInput {
  text: string;
  /** Never Person About text, never credentials. */
  context: {
    sessionName?: string | null;
    style?: string | null;
    mood?: string | null;
    genres?: string[];
    /** The configured image model, so the rewrite can target its strengths. */
    imageModel?: string | null;
  };
}

export interface CoverDirectionEnhancement {
  text: string;
  /** False whenever the raw text came back (no rewrite, failure, or empty input). */
  applied: boolean;
}

// The canonical `ListenerContext` lives in `@liedmotif/shared` (produced by
// `@liedmotif/db`, consumed here); re-exported so LLM consumers get it with the
// provider interface.
import type { ListenerContext } from '@liedmotif/shared';

export type { ListenerContext };

export interface LlmProvider extends BaseProvider {
  readonly providerType: 'llm';
  getCapabilities(): LlmProviderCapabilities;
  /**
   * Free-text/voice path ONLY: expand a natural-language intent into a validated
   * Style Snapshot. Throws a sanitized `ProviderError` if it cannot (after one
   * repair retry) — the caller must not start paid music generation in that case.
   * `listener` (when provided) informs naming and, for vocal intents, the
   * snapshot's `lyricContext` selection. `picks` are the user's explicit
   * fine-tune picks (genres/energy/vocal/voice): the provider must guarantee
   * they shape the snapshot — deterministically, never by trusting the model.
   */
  expandSessionIntent(
    intent: string,
    listener?: ListenerContext | null,
    picks?: StylePicks,
    options?: ExpansionOptions,
  ): Promise<SessionStyleSnapshot>;
  expandSessionIntentWithMetadata(
    intent: string,
    listener?: ListenerContext | null,
    picks?: StylePicks,
    options?: ExpansionOptions,
  ): Promise<ExpandedSessionIntent>;
  /**
   * Cosmetic title/artist metadata for a track. NON-BLOCKING and never throws: any
   * provider failure falls back to a deterministic derivation from the snapshot.
   * `trackIndex` keeps fallback titles/artists distinct across a Session.
   */
  createTrackMetadata(snapshot: SessionStyleSnapshot, trackIndex?: number): Promise<TrackMetadata>;
  /**
   * Creative session naming (Name proposal + track-title pool) for a snapshot that
   * lacks them — the structured-controls / More Like This paths, where no expansion
   * call runs. Never throws, and bounded by a short timeout (it is awaited in the
   * create path, so a slow model may only briefly delay — never fail — creation).
   * Any failure returns EMPTY metadata; the consumer then composes the
   * deterministic Name (`deriveSessionTitle`), which has that job to itself. At
   * most one call per session creation, so the "text LLM runs ~once per session"
   * posture holds.
   */
  createSessionMetadata(input: SessionNamingInput): Promise<SessionNamingMetadata>;
  /**
   * Per-generation track lyric brief: one bounded
   * best-effort call that writes a fresh compact lyric direction differing from
   * the session's recent briefs.
   * NEVER throws — any failure returns '', and the caller falls back to the
   * static session `lyricContext`; generation never blocks on the brief.
   */
  createTrackLyricBrief(input: TrackLyricBriefInput): Promise<string>;
  /**
   * Track-title pool refill: fresh creative titles
   * for a Session about to run past its pool, each different from every taken
   * title (the caller's locked append drops any that collide anyway). One bounded
   * best-effort call that NEVER throws — any failure returns [], and the Track
   * falls back to a numbered repeat of a pool title.
   */
  createTrackTitles(input: TrackTitlesInput): Promise<string[]>;
  /**
   * Surprise Me: write one fresh listening request from a
   * subject and the music, which the caller then expands like a typed request.
   * Sees the owner's city and country at most — never People or About. Throws
   * a sanitized `ProviderError` on any failure: the proposal is then a
   * retryable error, never a silent deterministic fallback.
   */
  createSurpriseRequest(input: SurpriseRequestInput): Promise<SurpriseRequest>;
  /**
   * Rewrite user-written cover art direction (regenerate guidance, custom style
   * definitions) into image-model-aware phrasing. One bounded call that NEVER
   * throws and never blocks the action: any failure, timeout, or empty rewrite
   * returns the raw text with `applied: false`. Runs at the web boundary before
   * an attempt's plan inputs are frozen — the cover generator stays
   * LLM-free, and the deterministic worker sanitizer still applies afterwards.
   */
  enhanceCoverDirection(input: CoverDirectionInput): Promise<CoverDirectionEnhancement>;
}

export {
  sessionStyleSnapshotSchema,
  MAX_STYLE_PROMPT_LENGTH,
  MAX_LYRIC_CONTEXT_LENGTH,
  MAX_TRACK_LYRIC_BRIEF_LENGTH,
  MAX_TRACK_TITLE_POOL,
  clampTrackLyricBrief,
  trackTitleRefillCount,
} from './snapshot';
export type { SessionStyleSnapshot, VocalMode, EnergyLevel, VoiceGender } from './snapshot';

export {
  compileStructuredControls,
  buildSessionStyle,
  buildTrackPrompt,
  budgetDescription,
  deriveTrackMetadata,
  deriveSiblingTrackTitles,
  frozenBpmKeyTag,
  inheritedGuardrails,
} from './template';
export type { StructuredControls, StylePicks, TrackPromptParams, TrackMetadata } from './template';

export { deriveSessionMetadata, deriveSessionSnapshot } from './derive';
export type { SessionIntentInput } from './derive';

export { deriveSessionTitle, MAX_SESSION_TITLE_LENGTH } from './session-title';
export type { SessionTitleSnapshot, SessionNamingMetadata } from './session-title';

export {
  createOpenAiCompatibleLlmProvider,
  createOpenAiLlmProvider,
  createOpenRouterLlmProvider,
  createOllamaLlmProvider,
} from './openai-compatible';
export type { OpenAiCompatibleLlmConfig } from './openai-compatible';
