// Word-level lyric timing — the ONE shape for provider-aligned lyric words.
// Providers normalize vendor payloads into it, the DB persists it verbatim as
// `tracks.timed_lyrics`, and the line-grouping logic consumes it.

/** One aligned lyric word (timestamps in seconds from track start). */
export interface TimedLyricWord {
  /** Verbatim word text, including the provider's whitespace/newlines. */
  word: string;
  startSeconds: number;
  endSeconds: number;
  /** False for filler/structure entries the provider could not align (e.g. `[Verse]`). */
  success: boolean;
}

/** Word-level lyric timing for one track. */
export interface TimedLyrics {
  words: TimedLyricWord[];
  /** Provider alignment error score (lower is better); null when unreported. */
  alignmentErrorScore: number | null;
}
