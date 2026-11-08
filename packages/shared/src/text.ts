// Small text helpers shared across packages so term normalization has one source
// of truth (cover-vibe matching, deterministic prompt compilation, future scoring).

import { MAX_COVER_STYLE_HINT_LENGTH } from './contracts/domain';

export const MAX_PROMPT_SESSION_NAME_LENGTH = 60;

/** Longest persisted Session Name — Derived at creation and the Rename bound:
 * what derivation produces is exactly what a Given Name may be. */
export const MAX_SESSION_TITLE_LENGTH = MAX_PROMPT_SESSION_NAME_LENGTH;

/** Longest persisted Track title, applied wherever a title enters the system:
 *  LLM pool entries, storage-key slugs, and Given Names via Rename. */
export const MAX_TRACK_TITLE_LENGTH = 80;

/** Playlist names are owner-typed; matches the Session title budget for UI parity. */
export const MAX_PLAYLIST_NAME_LENGTH = 60;

/** Collapse whitespace and truncate at a word boundary, appending an ellipsis.
 *  The result, ellipsis included, never exceeds `maxLength`: strict response
 *  contracts bound stored Session Names by the same cap. */
export function clampAtWord(text: string, maxLength: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  const cut = collapsed.slice(0, maxLength);
  const boundary = cut.lastIndexOf(' ');
  const head = boundary > 0 ? cut.slice(0, boundary) : cut.slice(0, maxLength - 1);
  return `${head.replace(/[\s,;:.!?]+$/, '')}…`;
}

/** The deterministic Session Name used when no text LLM proposed one. */
export function derivePromptSessionName(prompt: string): string {
  const clamped = clampAtWord(prompt, MAX_PROMPT_SESSION_NAME_LENGTH);
  if (!clamped) return 'Instrumental Session';
  return clamped.charAt(0).toUpperCase() + clamped.slice(1);
}

/** Capitalize each word of a title written entirely in lowercase. A title that
 *  already carries any capital is left as written: its language's own title
 *  conventions (German nouns, French sentence case) are not ours to rewrite. */
export function capitalizeLowercaseTitle(title: string): string {
  if (/\p{Lu}/u.test(title)) return title;
  // A word starts after whitespace or an opening quote/bracket — never after an
  // apostrophe, which sits inside words ("don't").
  return title.replace(
    /(^|[\s"“„«([¿¡])(\p{Ll})/gu,
    (_, lead: string, letter: string) => lead + letter.toUpperCase(),
  );
}

/**
 * Escape a string for literal use inside a regular expression. One definition
 * serves both halves of search matching — the SQL word-start pattern and the
 * client-side snippet highlighting — so they can never disagree on what a
 * "literal" query is.
 */
export function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
}

/** Lowercase free text and split it into alphanumeric word tokens (empties dropped). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Normalize a discrete tag/term to a trimmed, lowercased token. */
export function normalizeTerm(term: string): string {
  return term.trim().toLowerCase();
}

/**
 * Deterministic normalization for the `Custom style` cover hint — the no-LLM
 * fallback (and the clamp applied to LLM rewrites): control characters become
 * spaces, whitespace collapses, and the result is trimmed and bounded. Returns
 * `''` when nothing survives (callers then omit the hint entirely).
 */
export function sanitizeCoverStyleHint(raw: string): string {
  const normalized = raw
    .normalize('NFC')
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(normalized),
    (part) => part.segment,
  )
    .slice(0, MAX_COVER_STYLE_HINT_LENGTH)
    .join('')
    .trim();
}

export const MAX_COVER_CONCEPT_LENGTH = 200;

export function sanitizeCoverConcept(raw: string): string {
  const normalized = raw
    .normalize('NFC')
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(normalized),
    (part) => part.segment,
  )
    .slice(0, MAX_COVER_CONCEPT_LENGTH)
    .join('')
    .trim();
}

/**
 * Turn free text into a filesystem/URL-safe slug: lowercase ASCII words joined by
 * single dashes, truncated at a word boundary. Diacritics fold to their base
 * letters; anything else non-alphanumeric becomes a separator. Returns `''` when
 * nothing survives — callers supply their own fallback.
 */
export function slugify(text: string, maxLength = 48): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('-');
  if (slug.length <= maxLength) return slug;
  const cut = slug.slice(0, maxLength + 1);
  const boundary = cut.lastIndexOf('-');
  return boundary > 0 ? cut.slice(0, boundary) : slug.slice(0, maxLength);
}
