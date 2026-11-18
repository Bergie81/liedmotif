// Create-path Style-Snapshot derivation: the ONE place a Session's single
// Style Snapshot is produced from the user's intent. A configured text LLM is
// ALWAYS used for the free-text/voice path; without one, every intent compiles
// deterministically — structured controls via the template, free text via
// the prompt passthrough, a picks-only Change Vibe by applying the picks to
// the running snapshot — so the music path (the one
// hard-required provider) never depends on a configured LLM. Per-track
// generation later reuses the persisted snapshot with no further LLM call.

import {
  applyGuardrails,
  applyStylePicks,
  compilePromptPassthrough,
  compileStructuredControls,
  freezeStyleParameters,
  type SessionGuardrails,
  type StructuredControls,
  type StylePicks,
} from './template';
import type { EnergyLevel, SessionStyleSnapshot, VocalMode, VoiceGender } from './snapshot';
import type { ExpandedSessionIntent } from './index';
// Type-only import (erased at build): mirrors `mock.ts`, so no runtime cycle.
import type { ExpansionOptions, ListenerContext, LlmProvider } from './index';

/** The explicit fine-tune picks an intent may carry beside its words. */
type IntentPicks = SessionGuardrails & {
  genres?: string[];
  energy?: EnergyLevel;
  vocal?: VocalMode;
  voice?: VoiceGender;
  /** Sing with the user's own voice profile (rides with `vocal: 'vocal'`). */
  ownVoice?: boolean;
  /** Explicit session-language pick (canonical English name); omitted =
   * Auto Detect (the expansion derives it from the request). */
  language?: string;
};

/** The intents a Style Snapshot is derived from: a free-text prompt or
 * structured controls (the two create inputs), or — on a Change Vibe only —
 * picks alone. A prompt intent's picks must be honored by whichever producer
 * runs (the LLM expansion when one is configured, the deterministic passthrough
 * when not) over whatever the words alone suggest. Structured controls always
 * compile through the template. A picks intent has no words: it adjusts the
 * running snapshot (`adjustFrom`) by its picks and nothing else. */
export type SessionIntentInput =
  | { mode: 'controls'; controls?: StructuredControls }
  | (IntentPicks & { mode: 'prompt'; prompt: string })
  | (IntentPicks & { mode: 'picks' });

type WordsOrPicksIntent = Exclude<SessionIntentInput, { mode: 'controls' }>;

/** The intent's explicit picks, or undefined when it carries none. */
function intentPicks(input: WordsOrPicksIntent): StylePicks | undefined {
  const { genres, energy, vocal, voice, ownVoice, language, avoid } = input;
  return genres?.length || energy || vocal || voice || ownVoice !== undefined || language || avoid
    ? { genres, energy, vocal, voice, ownVoice, language, avoid }
    : undefined;
}

/** What the expansion reads as the change request: a picks intent has none,
 * which is how the adjustment prompt knows the picks are the only change. */
function requestText(input: WordsOrPicksIntent): string {
  return input.mode === 'prompt' ? input.prompt : '';
}

/** The snapshot a picks intent adjusts. Without one there is nothing to apply
 * the picks to; the caller refuses before deriving. */
function picksAnchor(options: ExpansionOptions | undefined): SessionStyleSnapshot {
  if (!options?.adjustFrom) {
    throw new Error('A picks-only change needs the running Style Snapshot to adjust.');
  }
  return options.adjustFrom;
}

function requireAnchorForPicks(input: WordsOrPicksIntent, options: ExpansionOptions | undefined) {
  if (input.mode === 'picks') picksAnchor(options);
}

/** A picks-only change with no text LLM: the running style with the picks
 * enforced by the same rules that guard every producer, and nothing else. The
 * words stay as they are — without a model nothing can reword them — so a pick
 * adds its own tag next to them. Own voice is not carried here: the caller
 * re-sends it as a pick so the voice profile is re-checked. */
function adjustByPicks(anchor: SessionStyleSnapshot, picks: StylePicks | undefined) {
  return freezeStyleParameters(
    applyStylePicks({ ...anchor, useOwnVoice: false, safetyWarnings: [] }, picks),
  );
}

/** The no-LLM producer for words or picks: the prompt passthrough, or the
 * picks applied to the running snapshot. */
function deterministicSnapshot(
  input: WordsOrPicksIntent,
  options: ExpansionOptions | undefined,
): SessionStyleSnapshot {
  return input.mode === 'picks'
    ? adjustByPicks(picksAnchor(options), intentPicks(input))
    : compilePromptPassthrough(input.prompt, intentPicks(input), options?.adjustFrom);
}

/**
 * The intent's Session Guardrails, from whichever branch carries them. On an
 * ADJUSTMENT (Change Vibe) the snapshot being adjusted fills what the intent
 * leaves out, so a change that never touches a guardrail carries the running
 * Session's value forward instead of falling back to the domain default. An
 * empty-string `avoid` is a value, not an omission: it is how a cleared Avoid
 * box reaches here.
 */
function intentGuardrails(
  input: SessionIntentInput,
  anchor: SessionStyleSnapshot | undefined,
): SessionGuardrails {
  const source = input.mode === 'controls' ? (input.controls ?? {}) : input;
  return {
    styleStrength: source.styleStrength ?? anchor?.styleStrength,
    novelty: source.novelty ?? anchor?.novelty,
    avoid: source.avoid ?? anchor?.userAvoid,
  };
}

/** Stamp the Guardrails onto whatever a producer returns, resolved once per
 *  derivation: which values apply, and (on an adjustment) whose Avoid terms the
 *  merge must clear out first. */
function guardrailStamp(
  input: SessionIntentInput,
  options: ExpansionOptions | undefined,
): (produced: SessionStyleSnapshot) => SessionStyleSnapshot {
  const anchor = options?.adjustFrom;
  const guardrails = intentGuardrails(input, anchor);
  return (produced) => applyGuardrails(produced, guardrails, anchor?.userAvoid);
}

/**
 * Derive the session's single Style Snapshot from its intent. A configured text
 * LLM ALWAYS expands a free-text intent — and an LLM failure propagates, never
 * silently degrading to the passthrough; it also rewords the running style for
 * a picks-only Change Vibe, in one call with no change message. With
 * `llm === null` every intent compiles deterministically: structured controls
 * via the template, free text via the prompt passthrough, picks onto the
 * running snapshot. The result
 * is the frozen snapshot persisted to `sessionStyleSnapshot`; every per-track
 * prompt is built from it without another LLM call. The listener profile (when
 * any) reaches only the LLM path — the deterministic producers never
 * personalize (personalization is LLM-gated).
 *
 * All producers converge on `applyGuardrails` here, so the Session Guardrails
 * are stamped exactly once, on whichever path produced the snapshot.
 */
export async function deriveSessionSnapshot(
  input: SessionIntentInput,
  llm: LlmProvider | null,
  listener?: ListenerContext | null,
  options?: ExpansionOptions,
): Promise<SessionStyleSnapshot> {
  const stamp = guardrailStamp(input, options);
  if (input.mode === 'controls') return stamp(compileStructuredControls(input.controls));
  if (!llm) return stamp(deterministicSnapshot(input, options));
  requireAnchorForPicks(input, options);
  const snapshot = await llm.expandSessionIntent(
    requestText(input),
    listener,
    intentPicks(input),
    options,
  );
  return stamp(snapshot);
}

/** A derived Session's metadata, with whether its request includes the listener settled. */
export type DerivedSessionIntent = ExpandedSessionIntent & { includesListener: boolean };

/**
 * Whether an expanded request includes the listener. The model's answer
 * decides; where it gave none, an adjustment keeps the running Session's answer
 * and a new Session has none. A Session started without the profile never
 * includes the listener.
 */
function resolveIncludesListener(
  options: ExpansionOptions | undefined,
  answer: boolean | undefined,
): boolean {
  if (options?.skipProfile === true) return false;
  return answer ?? options?.includesListener ?? false;
}

export async function deriveSessionMetadata(
  input: SessionIntentInput,
  llm: LlmProvider | null,
  listener?: ListenerContext | null,
  options?: ExpansionOptions,
): Promise<DerivedSessionIntent> {
  const stamp = guardrailStamp(input, options);
  // Without a text LLM nothing reads the request, so it never includes the listener.
  if (input.mode === 'controls') {
    return {
      snapshot: stamp(compileStructuredControls(input.controls)),
      coverConcept: '',
      autoCoverStyle: null,
      includesListener: false,
    };
  }
  if (!llm) {
    return {
      snapshot: stamp(deterministicSnapshot(input, options)),
      coverConcept: '',
      autoCoverStyle: null,
      includesListener: false,
    };
  }
  requireAnchorForPicks(input, options);
  const expanded = await llm.expandSessionIntentWithMetadata(
    requestText(input),
    listener,
    intentPicks(input),
    options,
  );
  return {
    ...expanded,
    snapshot: stamp(expanded.snapshot),
    includesListener: resolveIncludesListener(options, expanded.includesListener),
  };
}
