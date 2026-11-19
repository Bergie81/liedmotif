// Lyric line building: the provider gives (a) the plain lyric TEXT, whose line
// breaks and `[Section]` tags are the song's real structure, and (b) optionally a
// word-level timing stream. Lines are the display/seek unit, so the words are
// matched back onto the text lines here — over a normalized character stream,
// because the provider's word chunks cross word boundaries and drop punctuation.

import type { TimedLyrics } from './timed';

/** One display row of a track's lyrics. */
export type LyricLine =
  { kind: 'section'; label: string } | { kind: 'line'; text: string; timeSeconds: number | null };

export interface LyricLinesResult {
  lines: LyricLine[];
  /** True when enough lines carry a time for follow-the-playhead display.
   *  When false, every `timeSeconds` is null — one consistent unsynced shape. */
  synced: boolean;
}

/** Fewer timed lines than this is too little to follow — the view degrades to unsynced. */
const MIN_SYNCED_LINES = 2;
/** Minimum fraction of text lines that must match the word stream to trust it. */
const MIN_SYNCED_COVERAGE = 0.6;
/** Provider alignment error (`hootCer`, lower is better) above which the
 *  timing is distrusted wholesale. The score's exact scale is undocumented, so
 *  the gate is deliberately lenient — line coverage does the fine filtering. */
const MAX_ALIGNMENT_ERROR = 0.5;

/** A text line this short (normalized characters) is an ad-lib-sized fragment
 *  ("Yeah yeah") that recurs by chance inside later lines; it binds only right
 *  after the previous match, with no stream word between, so a skipped one
 *  cannot pull every line after it ahead. */
const SHORT_LINE_MAX_CHARS = 8;

const SECTION_TAG = /^\[(.+)\]$/;
/** A bracketed marker (`[Chorus]`): structure, never sung. The provider times
 *  its own markers in the word stream, unaligned. */
const BRACKETED = /\[[^\]]*\]/g;

/** Split raw lyric text into section labels and text lines (blanks dropped). */
export function parseLyricsText(text: string): LyricLine[] {
  return text
    .split(/\r?\n/)
    .map((raw) => raw.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const label = SECTION_TAG.exec(line)?.[1]?.trim();
      return label
        ? ({ kind: 'section', label } as const)
        : ({ kind: 'line', text: line, timeSeconds: null } as const);
    });
}

/** Case/punctuation/word-boundary-insensitive folding for the stream match,
 *  with bracketed markers left out on both sides: a sung line can neither bind
 *  to a marker nor be kept apart from the previous line by one. */
function normalizeForMatch(text: string): string {
  return text
    .replace(BRACKETED, ' ')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Build the display lines for a track: the parsed text, with each line timed
 * from the word stream when one is given. Matching is sequential (a repeated
 * chorus line binds to its NEXT occurrence), a line the stream cannot produce
 * stays untimed, and a time that would scroll backwards is dropped. A section
 * tag is structure, not sung text: it never searches the stream and never moves
 * the match forward. A normal-length line binds wherever its words next occur;
 * a short line binds only when no stream word lies between it and the previous
 * match, so a skipped ad-lib stays untimed instead of claiming a later line's
 * words. The provider's own section markers in the stream count as nothing. If
 * too few lines match — or the provider itself reports poor alignment — the
 * whole result degrades to the unsynced parse rather than half-following the
 * playhead.
 */
export function buildLyricLines(text: string, timed: TimedLyrics | null): LyricLinesResult {
  const lines = parseLyricsText(text);
  if (!timed || timed.words.length === 0) return { lines, synced: false };
  if (timed.alignmentErrorScore !== null && timed.alignmentErrorScore > MAX_ALIGNMENT_ERROR) {
    return { lines, synced: false };
  }

  // The normalized word stream, with each word's character span kept so a match
  // position maps back to the word (and its start time) that produced it.
  let stream = '';
  const spans: Array<{ start: number; end: number; startSeconds: number; success: boolean }> = [];
  // Where each stream word starts. A provider chunk can hold a whole line, so
  // the distance a short line may bind across is counted in these, not chunks.
  const wordStarts: number[] = [];
  for (const word of timed.words) {
    const norm = normalizeForMatch(word.word);
    if (!norm) continue;
    let wordAt = stream.length;
    for (const [token] of word.word.replace(BRACKETED, ' ').matchAll(/\S+/g)) {
      const length = normalizeForMatch(token).length;
      if (length === 0) continue;
      wordStarts.push(wordAt);
      wordAt += length;
    }
    spans.push({
      start: stream.length,
      end: stream.length + norm.length,
      startSeconds: word.startSeconds,
      success: word.success,
    });
    stream += norm;
  }

  let cursor = 0;
  const timedLines = lines.map((line) => {
    if (line.kind === 'section') return line;
    const needle = normalizeForMatch(line.text);
    if (!needle) return line;
    const at = stream.indexOf(needle, cursor);
    if (at === -1) return line;
    if (
      needle.length <= SHORT_LINE_MAX_CHARS &&
      wordStarts.some((start) => start >= cursor && start < at)
    ) {
      return line;
    }
    cursor = at + needle.length;
    // The line's time is its first ALIGNED word; unaligned filler only counts
    // when the provider aligned nothing in the match at all.
    const overlapping = spans.filter((span) => span.end > at && span.start < cursor);
    const anchor = overlapping.find((span) => span.success) ?? overlapping[0];
    return anchor ? { ...line, timeSeconds: anchor.startSeconds } : line;
  });

  // Never scroll backwards: a time below the running maximum is a glitch — drop it.
  let previous = -Infinity;
  const monotonic = timedLines.map((line) => {
    if (line.kind !== 'line' || line.timeSeconds === null) return line;
    if (line.timeSeconds < previous) return { ...line, timeSeconds: null };
    previous = line.timeSeconds;
    return line;
  });

  const textLines = monotonic.filter((line) => line.kind === 'line');
  const matched = textLines.filter((line) => line.timeSeconds !== null).length;
  const synced = matched >= MIN_SYNCED_LINES && matched / textLines.length >= MIN_SYNCED_COVERAGE;
  return synced ? { lines: monotonic, synced } : { lines, synced: false };
}
