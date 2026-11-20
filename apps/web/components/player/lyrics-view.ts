// Pure lyric-view logic for the sleeve-back panel and the Lyrics sheet: which
// line is lit for a playback position, and the past/active/next state each row
// renders with (the draft design's `data-state` contract). Kept out of the
// React shells so the state rules are unit-testable without a DOM.

import type { LyricLine, VocalMode } from '@liedmotif/shared';

export type LyricLineState = 'past' | 'active' | 'next';

/** What a lyrics surface shows — exactly one phase at a time. */
export type LyricsSurfacePhase =
  /** The words are not written yet ("Writing the words"). */
  | 'pending'
  /** Fetching a track whose words are already captured. */
  | 'loading'
  /** Final and empty ("No lyrics for this track"). */
  | 'empty'
  /** Words on screen. */
  | 'lines';

/**
 * The index of the ACTIVE line — the timed line with the greatest
 * `timeSeconds <= position`. -1 when nothing is active (unsynced view, no
 * position, or the position is before the first timed line).
 */
export function activeLyricLineIndex(lines: LyricLine[], positionSeconds: number | null): number {
  if (positionSeconds == null) return -1;
  let active = -1;
  let activeAt = -Infinity;
  lines.forEach((line, index) => {
    if (line.kind !== 'line' || line.timeSeconds === null) return;
    if (line.timeSeconds <= positionSeconds && line.timeSeconds > activeAt) {
      active = index;
      activeAt = line.timeSeconds;
    }
  });
  return active;
}

/**
 * The render state of every row for one active index (from
 * `activeLyricLineIndex` — the shells poll the clock and only re-render when
 * the index moves). Sections and untimed lines are always `next` (they never
 * light up or read as sung); on an unsynced view every row is `next` — the
 * words read as plain text. Timed lines are monotonic (server contract), so
 * "past" is simply "timed and before the active line".
 */
export function lyricLineStates(
  lines: LyricLine[],
  activeIndex: number,
  synced: boolean,
): LyricLineState[] {
  return lines.map((line, index) => {
    if (!synced || line.kind !== 'line' || line.timeSeconds === null) return 'next';
    if (index === activeIndex) return 'active';
    return index < activeIndex ? 'past' : 'next';
  });
}

/** What the lyrics affordances gate on — the two Track facts, together. */
export interface LyricsGate {
  vocalMode: VocalMode;
  hasLyrics: boolean;
}

/** Whether the lyrics affordances render at all for the current track: a vocal
 *  Track whose words are captured. An affordance that opens onto "no lyrics"
 *  is a dead end, so presence gates the entry point, not just the panel copy.
 *  Every surface behind this gate can therefore assume captured words. */
export function showLyricsAffordance(track: LyricsGate | null): boolean {
  return track?.vocalMode === 'vocal' && track.hasLyrics;
}

/** The one interaction contract of a lyric-line button, shared by both
 *  surfaces (their markup differs by design; their behavior must not). */
export function lyricLineInteraction(
  line: Extract<LyricLine, { kind: 'line' }>,
  state: LyricLineState,
  synced: boolean,
  seekTo: (seconds: number) => void,
) {
  return {
    type: 'button' as const,
    'data-state': state,
    'aria-current': state === 'active' ? ('true' as const) : undefined,
    disabled: !synced || line.timeSeconds === null,
    onClick: () => {
      if (line.timeSeconds !== null) seekTo(line.timeSeconds);
    },
  };
}

/** Shared copy for the two phases that render a single line of text. */
export const LYRICS_PHASE_COPY: Record<'loading' | 'empty', string> = {
  loading: 'Loading…',
  empty: 'No lyrics for this track',
};

export interface LyricsTimingStatus {
  /** The panel's footer line, and the sheet card's headline. */
  label: string;
  /** `lamp` is the app's "still being produced" tone (pulsing dot); `neutral`
   *  states a fact. */
  tone: 'lamp' | 'neutral';
  /** The sheet card's second line; null when there is no card to show. */
  detail: string | null;
}

/** The timing status of an open lyrics view: an unsynced view is only a dead
 *  end once the answer is settled — while it isn't, the surface keeps polling
 *  and the lines light up on their own. */
export function lyricsTimingStatus(timing: {
  synced: boolean;
  settled: boolean;
}): LyricsTimingStatus {
  if (timing.synced) return { label: 'Tap a line to jump', tone: 'neutral', detail: null };
  if (!timing.settled) {
    return {
      label: 'Line timing is on its way',
      tone: 'lamp',
      detail: 'The lines light up and follow the playhead once the track finishes rendering.',
    };
  }
  return {
    label: 'No line timing for this track',
    tone: 'neutral',
    detail: 'The words are all here — they just don’t follow the playhead or jump.',
  };
}
