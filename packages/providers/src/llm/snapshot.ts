// The Style Snapshot: the frozen style a Session reuses to build every track's
// prompt. It is produced two ways that converge on THIS one shape —
// the deterministic structured-control template (no LLM) and the text LLM
// expansion (free-text/voice). Keeping the required surface minimal (only
// `stylePrompt`) lets weak OpenAI-compatible and local Ollama models satisfy it;
// everything else defaults, so a partial model response still validates.

import { z } from 'zod';
import {
  capitalizeLowercaseTitle,
  MAX_SESSION_AVOID_LENGTH,
  MAX_TRACK_TITLE_LENGTH,
} from '@liedmotif/shared';
import { sanitizeLanguage } from './language';

// Re-exported: the language allowlist lives in `./language`, but consumers take
// every snapshot-boundary clamp/sanitizer from this module.
export { sanitizeLanguage };

export const VOCAL_MODES = ['instrumental', 'vocal'] as const;
export const ENERGY_LEVELS = ['low', 'medium', 'high'] as const;
export const VOICE_GENDERS = ['female', 'male'] as const;

export type VocalMode = (typeof VOCAL_MODES)[number];
export type EnergyLevel = (typeof ENERGY_LEVELS)[number];
export type VoiceGender = (typeof VOICE_GENDERS)[number];

/** Keep only a known voice gender; anything else is unset ('' — provider default).
 *  The value rides a per-track prompt tail, so junk is dropped, never passed on. */
export function sanitizeVoiceGender(value: string): VoiceGender | '' {
  const normalized = value.trim().toLowerCase();
  return (VOICE_GENDERS as readonly string[]).includes(normalized)
    ? (normalized as VoiceGender)
    : '';
}

/** Generous cap; the music provider enforces its own (tighter) style length. */
export const MAX_STYLE_PROMPT_LENGTH = 1000;

/** Cap on the LLM-produced personal lyric notes: the Session's base lyric
 *  direction, which the per-generation brief call reads. Sized so six People
 *  can each have a part in the scene beside theme, imagery, and arc. */
export const MAX_LYRIC_CONTEXT_LENGTH = 500;

/** How much lyric direction rides a vocal track's compiled description TAIL
 *  (the part `styleWithTail` guarantees survives a provider clamp): it must
 *  leave the non-custom prompt cap (Suno: 500) enough room for the style base.
 *  A per-track brief always fits; base notes submitted in a brief's place keep
 *  their head, where the theme leads. */
export const MAX_DESCRIPTION_LYRIC_LENGTH = 240;

/** Bounds on the LLM-proposed track-title pool, applied wherever a pool enters the
 *  system (schema parse of a model reply / stored jsonb, and the naming call's
 *  normalization) so a runaway model response cannot bloat titles or storage keys.
 *  The pool grows by refills as a Session plays (one title per Track ordinal), so
 *  the cap is sized for a very long Session — every request row freezes a copy. */
export { MAX_TRACK_TITLE_LENGTH };
export const MAX_TRACK_TITLE_POOL = 200;

/** How many fresh titles one pool refill asks the text LLM for. */
const TRACK_TITLE_REFILL_COUNT = 12;

/** Clamp a proposed track-title pool: entries trimmed, length-capped, and
 *  capitalized when written all in lowercase; blanks dropped; the pool capped. */
export function clampTrackTitles(titles: string[]): string[] {
  return titles
    .map((entry) => capitalizeLowercaseTitle(entry.trim().slice(0, MAX_TRACK_TITLE_LENGTH)))
    .filter(Boolean)
    .slice(0, MAX_TRACK_TITLE_POOL);
}

/**
 * How many fresh titles to ask one refill for before request `requestIndex`,
 * whose `tracksPerRequest` sibling ordinals must each name a pool title — 0 for
 * no refill. Only a pool a model started is refilled, never past the cap, and
 * only when one batch reaches the request's ordinals: titles appended below them
 * would only ever name Tracks that already played, so a Session far past its
 * pool (named before refills existed, or after a long LLM outage) keeps the
 * numbered fallback.
 */
export function trackTitleRefillCount(
  poolLength: number,
  requestIndex: number,
  tracksPerRequest: number,
): number {
  const needed = (requestIndex + 1) * tracksPerRequest;
  if (poolLength === 0 || poolLength >= needed) return 0;
  const count = Math.min(TRACK_TITLE_REFILL_COUNT, MAX_TRACK_TITLE_POOL - poolLength);
  return poolLength + count >= needed ? count : 0;
}

/** Clamp proposed lyric notes wherever they enter the system (schema parse,
 *  the naming call's normalization) — mirrors `clampTrackTitles`. */
export function clampLyricContext(value: string): string {
  return value.trim().slice(0, MAX_LYRIC_CONTEXT_LENGTH);
}

/** Cap on an activity label a naming answer sets: the structured controls' own cap. */
export const MAX_SESSION_ACTIVITY_LENGTH = 120;

/** Clamp a proposed activity label where it enters the system — mirrors `clampLyricContext`. */
export function clampActivity(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_SESSION_ACTIVITY_LENGTH).trim();
}

/** Hard cap on a per-generation track lyric brief. Tighter than
 *  `MAX_DESCRIPTION_LYRIC_LENGTH`, so a brief reaches the provider whole. The
 *  own-voice path sends "Write the lyrics in <language>. " + brief into Suno's
 *  200-char lyrics-brief cap, which keeps the leading directive and cuts the
 *  brief's tail; the room for the directive comes from the prompt's soft target
 *  (`TRACK_LYRIC_BRIEF_TARGET_CHARS`), not from this cap. */
export const MAX_TRACK_LYRIC_BRIEF_LENGTH = 200;

/** Clamp a proposed track lyric brief where it enters the system (the adapter's
 *  model reply, the mock) — mirrors `clampLyricContext`. */
export function clampTrackLyricBrief(value: string): string {
  return value.trim().slice(0, MAX_TRACK_LYRIC_BRIEF_LENGTH);
}

// --- Session Guardrails -------------------------------------------------------
// All three are OPTIONAL on the snapshot, and absence is load-bearing: a Session
// created before guardrails existed carries none, and its Tracks must keep
// compiling with the provider parameters omitted so a Dislike reroll still
// sounds like its siblings. Producers stamp concrete values on every new
// snapshot, so only pre-guardrails snapshots ever parse to `undefined`.

/** Keep a Guardrail level inside the 0–1 domain range — clamped, never rejected,
 *  since a stored snapshot must always parse. */
export function clampGuardrailLevel(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Bound the verbatim Avoid text at the snapshot boundary; nothing left after
 *  trimming means the Session has no Avoid, so it drops to unset rather than ''. */
export function sanitizeUserAvoid(value: string): string | undefined {
  const trimmed = value.trim().slice(0, MAX_SESSION_AVOID_LENGTH);
  return trimmed ? trimmed : undefined;
}

/**
 * The frozen base seed a snapshot carries when no producer has derived one — a
 * deterministic constant so a bare `parse({ stylePrompt })` still yields a defined
 * `seedParameters.baseSeed`. Producers (the structured template, the free-text
 * backfill) overwrite it with a controls-derived value for per-session variety.
 */
export const DEFAULT_BASE_SEED = 0;

export const sessionStyleSnapshotSchema = z.object({
  stylePrompt: z.string().min(1).max(MAX_STYLE_PROMPT_LENGTH),
  negativeTerms: z.array(z.string()).default([]),
  mood: z.string().default(''),
  activity: z.string().default(''),
  genreTags: z.array(z.string()).default([]),
  vocalMode: z.enum(VOCAL_MODES).default('instrumental'),
  energy: z.enum(ENERGY_LEVELS).default('medium'),
  /** A cosmetic-title scheme/hint; titles never block playback. */
  titleScheme: z.string().default(''),
  // --- Creative naming (cosmetic, LLM-proposed) --------------------------------
  // Both default empty: the deterministic template never fills them, and a weak
  // model may omit them — consumers fall back to deterministic naming either way.
  /** LLM-proposed session Name; '' means "derive deterministically". */
  title: z.string().default(''),
  /** LLM-proposed pool of creative track titles, cycled per track ordinal.
   *  Clamped at parse, so every consumer of a PARSED snapshot sees bounded data. */
  trackTitles: z.array(z.string()).default([]).transform(clampTrackTitles),
  /**
   * Personal lyric notes for VOCAL sessions: a coherent group of listener-profile
   * details related to THIS request, organized into compact labeled categories such
   * as people, scene, imagery, and emotional arc. '' for instrumental sessions,
   * when no profile exists, or when no LLM ran (the deterministic paths never fill
   * it — personalization is LLM-gated).
   * Clamped at parse like `trackTitles`, so consumers see bounded data.
   */
  lyricContext: z.string().default('').transform(clampLyricContext),
  /**
   * The SESSION's language (an English name, e.g. "German"): the user's explicit
   * Language pick when one was made, else the request language the text LLM
   * detected on a vocal free-text request. It steers two things — the naming
   * prompts write title/trackTitles in it, and `buildTrackPrompt` turns it into
   * a per-track "<language> vocals" style tag on VOCAL sessions only (the tail
   * is mode-gated, so an instrumental session carries the language for titles
   * without it ever reaching the description). '' means unspecified (no pick and
   * nothing detected): no tag, provider default, titles follow the request.
   * Sanitized at parse — it reaches the provider prompt as a bare tag, so a
   * non-language value is dropped, never passed through.
   */
  language: z.string().default('').transform(sanitizeLanguage),
  /**
   * The explicit Voice (gender) pick for VOCAL sessions — from the create card's
   * fine-tune Voice control on either start tab. `buildTrackPrompt` merges it with
   * `language` into the per-track "<gender> <language> vocals" style tag. '' means
   * Any (no tag, provider default), and instrumental sessions always carry ''.
   * Sanitized at parse like `language` — out-of-vocabulary values are dropped.
   */
  voiceGender: z.string().default('').transform(sanitizeVoiceGender),
  /**
   * Sing with the user's own voice profile (the "Use my voice" opt-in under
   * vocals). Meaningful only when `vocalMode === 'vocal'` — producers force it
   * false for instrumental snapshots. The snapshot carries the INTENT only; the
   * worker resolves the owner's ready profile to a provider voice reference at
   * submit time and BLOCKS (never silently falls back to generic vocals) when
   * none is available.
   */
  useOwnVoice: z.boolean().default(false),
  safetyWarnings: z.array(z.string()).default([]),
  /**
   * How strictly the music model honors the compiled style (0–1). Never produced
   * by the text LLM — the producers stamp it deterministically from the intent's
   * pick or the domain default.
   */
  styleStrength: z.number().transform(clampGuardrailLevel).optional(),
  /** How far the music model may deviate into the experimental (0–1). Stamped
   *  deterministically like `styleStrength`. */
  novelty: z.number().transform(clampGuardrailLevel).optional(),
  /**
   * The user's Avoid text VERBATIM — the editable identity Change Vibe re-seeds
   * from. Its parsed terms already live in `negativeTerms` (merged after the
   * system terms), so consumers steer from there and never re-split this.
   */
  userAvoid: z.string().transform(sanitizeUserAvoid).optional(),
  // --- Frozen blend parameters ------------------------------------------------
  // A Session freezes ONE BPM and key so consecutive Tracks beat-match and blend
  // for free; variety comes from the hidden seed parameters, not BPM/key drift.
  // All three default, so a weak/partial model response (only `stylePrompt`) still
  // validates — a producer (the template, or a backfill) freezes concrete values.
  /** Frozen session BPM; `null` means "not yet frozen" (a producer fills it). */
  bpm: z.number().positive().nullable().default(null),
  /** Frozen musical key (e.g. "A minor") for harmonic mixing; '' until frozen. */
  key: z.string().default(''),
  /**
   * Hidden seed parameters rotated per-track / on reroll (Liedmotif's own seed) —
   * the SINGLE source `buildTrackPrompt` derives a per-track seed from. The
   * default carries a frozen `baseSeed` so even a bare `parse({ stylePrompt })`
   * yields a defined, deterministic seed (never `undefined`); producers overwrite
   * it with a controls-derived value for per-session variety.
   */
  seedParameters: z
    .record(z.string(), z.unknown())
    .default(() => ({ baseSeed: DEFAULT_BASE_SEED, rerollSalt: 0 })),
});

export type SessionStyleSnapshot = z.infer<typeof sessionStyleSnapshotSchema>;
