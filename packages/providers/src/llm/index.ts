// Text-LLM provider interface (the prompt expander).
//
// The text LLM is OPTIONAL: it produces the Style Snapshot ONLY for the
// free-text/voice create path. Structured controls compile to the same snapshot
// shape via a deterministic template (`./template`) with no LLM — so the music
// path (the one hard-required provider) never depends on a configured LLM. Title/artist metadata
// is cosmetic and must never block playback, buffering, or provider submission.
//
// The Assistant is the text LLM's one use outside the music path
// (`streamAssistantReply`): a tool-calling exchange per chat message.

import type { z } from 'zod';
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
  /** The cover preset the model picked for Auto; null when it gave no valid one. */
  autoCoverStyle: CoverStylePreset | null;
  /**
   * The model's reading of whether the request places the listener themself in
   * its scene ("me, Jonas and Clara on the moon"), as opposed to merely asking
   * for music; absent when it gave no answer. `deriveSessionMetadata` turns it
   * into the Session's answer.
   */
  includesListener?: boolean;
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
  /**
   * The model's reading of whether the direction places the listener themself
   * in the picture ("me dancing with Jonas", in any language); absent when it
   * gave no valid answer.
   */
  includesListener?: boolean;
}

// The canonical `ListenerContext` (produced by `@liedmotif/db`, consumed here)
// and `AssistantMessage` (the request contract's message) live in
// `@liedmotif/shared`; re-exported so LLM consumers get them with the provider
// interface.
import type { AssistantMessage, CoverStylePreset, ListenerContext } from '@liedmotif/shared';

export type { AssistantMessage, ListenerContext };

/**
 * A function the model may call while it writes a reply. Vendor-neutral: each
 * adapter maps it onto its own SDK's tool shape.
 */
export interface LlmTool<Input = unknown> {
  name: string;
  /** Tells the model what the tool is for and when to call it. */
  description: string;
  inputSchema: z.ZodType<Input>;
  /**
   * Runs with the validated input; what it returns is what the model reads.
   * A method, not a function property: that is what lets tools with different
   * input types sit in one `LlmTool[]`.
   */
  execute(input: Input): Promise<string>;
}

export interface AssistantReplyInput {
  system: string;
  /** The conversation so far, oldest first, ending with the user's message. */
  messages: readonly AssistantMessage[];
  tools: readonly LlmTool[];
  /** How many model calls may go to tools before the model has to answer. */
  maxToolSteps: number;
  /** Stops the exchange, e.g. when the user closes the chat mid-answer. */
  signal?: AbortSignal;
}

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
   * On an adjustment (`options.adjustFrom`) an empty `intent` means there is no
   * change message: the picks are the only change (a picks-only Change Vibe).
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
   * call runs. Without a context it never throws, and is bounded by a short
   * timeout (it is awaited in the create path, so a slow model may only briefly
   * delay — never fail — creation).
   * Any failure returns EMPTY metadata; the consumer then composes the
   * deterministic Name (`deriveSessionTitle`), which has that job to itself. At
   * most one call per session creation, so the "text LLM runs ~once per session"
   * posture holds.
   *
   * A More Like This context (`input.context`) or language pick
   * (`input.language`) makes the call required: it runs under the expansion's
   * budget, and throws a sanitized `ProviderError` when it cannot return a Name
   * and a title pool, so no Session starts that ignored them. A context's answer
   * also carries the `activity`, whether the listener is in the scene
   * (`includesListener`), on Auto Detect the context's `language` and, on a
   * vocal snapshot, lyric notes.
   */
  createSessionMetadata(input: SessionNamingInput): Promise<SessionNamingMetadata>;
  /**
   * Per-generation track lyric brief: one bounded
   * best-effort call that writes a fresh compact lyric direction differing from
   * the session's recent briefs, at most `MAX_TRACK_LYRIC_BRIEF_LENGTH` characters
   * (`clampTrackLyricBrief`).
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
  /**
   * The Assistant's reply to a conversation, as chunks of Markdown text in the
   * order the model writes them. The model may call the tools first; what they
   * return reaches the model only, never the stream. Outside the music path:
   * one exchange per chat message. Iterating throws a sanitized `ProviderError`
   * when the model cannot be reached or fails mid-answer — a retryable error for
   * the caller, never a substitute answer.
   */
  streamAssistantReply(input: AssistantReplyInput): AsyncIterable<string>;
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

export {
  CONTEXT_NAMING_FAILED,
  deriveSessionTitle,
  MAX_SESSION_TITLE_LENGTH,
} from './session-title';
export type { SessionTitleSnapshot, SessionNamingMetadata } from './session-title';

export {
  createOpenAiCompatibleLlmProvider,
  createGeminiLlmProvider,
  createOpenAiLlmProvider,
  createOpenRouterLlmProvider,
  createOllamaLlmProvider,
} from './openai-compatible';
export type { OpenAiCompatibleLlmConfig } from './openai-compatible';
