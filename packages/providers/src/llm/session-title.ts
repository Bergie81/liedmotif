// Session-title derivation. Creative when available, deterministic otherwise: a
// snapshot may carry an LLM-proposed `title` (from the free-text expansion or
// `createSessionMetadata`), which wins; without one, a free-text session is named
// from the user's own prompt and a structured/seeded session composes a name from
// its Style Snapshot's mood, activity, and genres. Total and never an LLM call
// itself, so naming never blocks creation (the text LLM stays optional).

import {
  clampAtWord,
  derivePromptSessionName,
  MAX_COVER_CONCEPT_LENGTH,
  MAX_SESSION_TITLE_LENGTH,
  sanitizeCoverConcept,
  type CoverStylePreset,
} from '@liedmotif/shared';

export { MAX_SESSION_TITLE_LENGTH };

export { MAX_COVER_CONCEPT_LENGTH };

/** The text LLM wrote the concept and its prompt already describes named
 *  references visually (ADR 0004), so only syntax and length are bounded here. */
export function clampCoverConcept(value: string): string {
  return sanitizeCoverConcept(value);
}

/** Why a More Like This context could not be honored: its naming call failed
 *  or answered no Name and title pool. Retryable, like a failed expansion. */
export const CONTEXT_NAMING_FAILED =
  'The text AI could not write names for that context. Try again.';

/** Creative naming a text LLM proposes for a session (all cosmetic; empty when
 *  the model omits them — consumers fall back to deterministic derivation). */
export interface SessionNamingMetadata {
  /** Proposed session Name, or '' when unavailable. */
  title: string;
  /** Proposed pool of creative track titles, one per track ordinal (refilled as a Session plays). */
  trackTitles: string[];
  /** Request-led compact lyric notes organized from related listener-profile details.
   *  CONTRACT: non-empty ONLY for a vocal session WITH a listener profile or a
   *  More Like This context — every implementation enforces this on its output,
   *  so consumers merge it into the snapshot without re-checking. */
  lyricContext: string;
  coverConcept: string;
  /** The cover preset the model picked for Auto; null when it gave no valid one. */
  autoCoverStyle: CoverStylePreset | null;
  /** The activity the Session is for, answered only for a More Like This
   *  context; '' when the model gave no valid one. */
  activity?: string;
  /** Whether the request puts the listener in its scene, answered only for a
   *  More Like This context; false when the model gave no valid answer. */
  includesListener?: boolean;
}

/** The snapshot fields a title composes from — a structural subset of both the
 *  provider `SessionStyleSnapshot` and the DB jsonb `StyleSnapshot` shapes. */
export interface SessionTitleSnapshot {
  /** LLM-proposed session Name; wins over derivation when present. */
  title?: string;
  mood?: string;
  activity?: string;
  genreTags?: string[];
  energy?: string;
  vocalMode?: string;
}

/** Capitalize each word's first letter. A letter, digit or apostrophe before it
 *  means mid-word ("don't", "1st"), so every script capitalizes alike. */
function titleCase(value: string): string {
  return value.replace(/(?<![\p{L}\p{N}_'’])\p{Ll}/gu, (c) => c.toUpperCase());
}

/**
 * Derive the session's display Name. Precedence: an LLM-proposed `snapshot.title`
 * (creative, when a text LLM produced one) → the user's free-text prompt, trimmed
 * and word-truncated → a composition from the snapshot (`Mood Activity · Genres`)
 * → energy + vocal mode, so even empty default controls yield something
 * descriptive. Total: always returns a non-empty title.
 */
export function deriveSessionTitle(source: {
  userPrompt?: string | null;
  snapshot: SessionTitleSnapshot;
}): string {
  const proposed = typeof source.snapshot.title === 'string' ? source.snapshot.title.trim() : '';
  if (proposed) return clampAtWord(proposed, MAX_SESSION_TITLE_LENGTH);

  const prompt = source.userPrompt?.trim() ?? '';
  if (prompt) return derivePromptSessionName(prompt);

  const { mood = '', activity = '', genreTags = [], energy = '', vocalMode } = source.snapshot;
  const moodActivity = [mood, activity]
    .map((part) => part.trim())
    .filter(Boolean)
    .map(titleCase)
    .join(' ');
  const genres = genreTags
    .slice(0, 2)
    .map((tag) => titleCase(tag.trim()))
    .filter(Boolean)
    .join(', ');
  const composed = [moodActivity, genres].filter(Boolean).join(' · ');
  if (composed) return clampAtWord(composed, MAX_SESSION_TITLE_LENGTH);

  const vocals = vocalMode === 'vocal' ? 'Vocal' : 'Instrumental';
  return energy ? `${titleCase(energy)} Energy ${vocals}` : `${vocals} Session`;
}
