// Create-path Style-Snapshot derivation: the ONE place a Session's single
// Style Snapshot is produced from the user's intent. A configured text LLM is
// ALWAYS used for the free-text/voice path; without one, every intent compiles
// deterministically — structured controls via the template,
// free text via the prompt passthrough — so the music path (the one
// hard-required provider) never depends on a configured LLM. Per-track
// generation later reuses the persisted snapshot with no further LLM call.

import {
  applyGuardrails,
  compilePromptPassthrough,
  compileStructuredControls,
  type SessionGuardrails,
  type StructuredControls,
  type StylePicks,
} from './template';
import type { EnergyLevel, SessionStyleSnapshot, VocalMode, VoiceGender } from './snapshot';
import type { ExpandedSessionIntent } from './index';
// Type-only import (erased at build): mirrors `mock.ts`, so no runtime cycle.
import type { ExpansionOptions, ListenerContext, LlmProvider } from './index';

/** The two create inputs: a free-text prompt or structured controls. A prompt
 * intent may carry explicit fine-tune picks (genres/energy/vocal/voice/language),
 * which whichever producer runs — the LLM expansion when one is configured, the
 * deterministic passthrough when not — must honor over whatever the words alone
 * suggest. Structured controls always compile through the template. */
export type SessionIntentInput =
  | { mode: 'controls'; controls?: StructuredControls }
  | (SessionGuardrails & {
      mode: 'prompt';
      prompt: string;
      genres?: string[];
      energy?: EnergyLevel;
      vocal?: VocalMode;
      voice?: VoiceGender;
      /** Sing with the user's own voice profile (rides with `vocal: 'vocal'`). */
      ownVoice?: boolean;
      /** Explicit session-language pick (canonical English name); omitted =
       * Auto Detect (the expansion derives it from the request). */
      language?: string;
    });

/** The prompt intent's explicit picks, or undefined when it carries none. */
function intentPicks(input: SessionIntentInput & { mode: 'prompt' }): StylePicks | undefined {
  const { genres, energy, vocal, voice, ownVoice, language, avoid } = input;
  return genres?.length || energy || vocal || voice || ownVoice !== undefined || language || avoid
    ? { genres, energy, vocal, voice, ownVoice, language, avoid }
    : undefined;
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
 * silently degrading to the passthrough. With `llm === null` every intent
 * compiles deterministically: structured controls via the template, free text
 * via the prompt passthrough. The result
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
  if (!llm) {
    return stamp(compilePromptPassthrough(input.prompt, intentPicks(input), options?.adjustFrom));
  }
  const snapshot = await llm.expandSessionIntent(
    input.prompt,
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
      includesListener: false,
    };
  }
  if (!llm) {
    return {
      snapshot: stamp(
        compilePromptPassthrough(input.prompt, intentPicks(input), options?.adjustFrom),
      ),
      coverConcept: '',
      includesListener: false,
    };
  }
  const expanded = await llm.expandSessionIntentWithMetadata(
    input.prompt,
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
