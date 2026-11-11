'use client';

// Lyrics data + sync hooks shared by the sleeve-back panel and the Lyrics
// sheet. The fetch runs only while a lyrics surface is actually open (`enabled`)
// — lyric text never rides the queue poll — and re-runs when the track changes,
// so a surface can never show the previous track's words. Until the answer is
// `settled` (the still-rendering job may yet deliver the words or their line
// timing) the hook re-asks on a slow cadence; the route's own caching makes
// every later ask a cheap DB read.

import { useEffect, useState } from 'react';
import type { LyricLine, TrackLyrics } from '@liedmotif/shared';
import { FAILURE_BACKOFF_JITTER, FAILURE_BACKOFF_MAX_MS, pollBackoffMs } from '@/lib/poll-backoff';
import {
  activeLyricLineIndex,
  lyricLineStates,
  type LyricLineState,
  type LyricsSurfacePhase,
} from './lyrics-view';
import type { PlaybackSample } from './playback-controller-api';
import { useTrackMedia } from './track-media';
import { pollWhileVisible } from './visible-poll';

const PENDING_POLL_MS = 5000;
const POSITION_POLL_MS = 250;

/** What a failed read shows before any answer has loaded: the empty view,
 *  unsettled so the re-ask below keeps retrying — a transient error must not
 *  strand an open surface. A later failed read keeps the words already shown. */
const EMPTY_RETRYING: TrackLyrics = { state: 'ready', lines: [], synced: false, settled: false };

/** One shared empty array, so the unloaded case keeps a stable `lines`
 *  identity and never re-arms the 250 ms sync effect below. */
const NO_LINES: LyricLine[] = [];

function useTrackLyrics(trackId: string | null, enabled: boolean): TrackLyrics | null {
  const [state, setState] = useState<{ trackId: string; lyrics: TrackLyrics } | null>(null);
  const { lyrics: readLyrics } = useTrackMedia();

  useEffect(() => {
    if (!enabled || !trackId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A failed read backs off (the endpoint is 5xx-ing); an OK-but-unsettled
    // read stays at the normal cadence — the job is still writing the words.
    let failures = 0;
    let loaded: TrackLyrics | null = null;
    const load = async () => {
      const result = await readLyrics(trackId);
      if (cancelled) return;
      if (result.ok) loaded = result.data;
      const lyrics = result.ok
        ? result.data
        : loaded
          ? { ...loaded, settled: false }
          : EMPTY_RETRYING;
      failures = result.ok ? 0 : failures + 1;
      setState({ trackId, lyrics });
      if (!lyrics.settled) {
        timer = setTimeout(
          () => void load(),
          pollBackoffMs({
            failures,
            baseMs: PENDING_POLL_MS,
            maxMs: FAILURE_BACKOFF_MAX_MS,
            jitterRatio: FAILURE_BACKOFF_JITTER,
          }),
        );
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [trackId, enabled, readLyrics]);

  return state && state.trackId === trackId ? state.lyrics : null;
}

/** Everything a lyrics surface renders from — one prelude for panel and sheet. */
export interface LyricsSurface {
  phase: LyricsSurfacePhase;
  lines: LyricLine[];
  synced: boolean;
  /** False while the view may still improve on its own (the surface keeps polling). */
  settled: boolean;
  states: LyricLineState[];
}

function surfacePhase(lyrics: TrackLyrics | null): LyricsSurfacePhase {
  // A surface only opens behind `showLyricsAffordance`, which already demands
  // captured words — so no response yet means the fetch is in flight, never
  // that the words are still being written. `pending` comes from the server.
  if (lyrics == null) return 'loading';
  if (lyrics.state === 'pending') return 'pending';
  return lyrics.lines.length === 0 ? 'empty' : 'lines';
}

export function useLyricsSurface(input: {
  trackId: string | null;
  enabled: boolean;
  getPlaybackSample: () => PlaybackSample;
}): LyricsSurface {
  const lyrics = useTrackLyrics(input.trackId, input.enabled);
  const lines = lyrics?.lines ?? NO_LINES;
  const synced = lyrics?.synced ?? false;
  const activeIndex = useActiveLyricLine(lines, synced, input.getPlaybackSample, input.enabled);
  return {
    phase: surfacePhase(lyrics),
    lines,
    synced,
    settled: lyrics?.settled ?? false,
    states: lyricLineStates(lines, activeIndex, synced),
  };
}

/**
 * The index of the line the playhead is on, polled from the player clock while
 * a synced surface is open. State only moves on a LINE boundary, so the
 * surface re-renders per line, not per clock tick.
 */
function useActiveLyricLine(
  lines: LyricLine[],
  synced: boolean,
  getPlaybackSample: () => PlaybackSample,
  enabled: boolean,
): number {
  const [active, setActive] = useState(-1);
  useEffect(() => {
    if (!enabled || !synced || lines.length === 0) {
      setActive(-1);
      return;
    }
    return pollWhileVisible(POSITION_POLL_MS, () => {
      const next = activeLyricLineIndex(lines, getPlaybackSample().positionSeconds);
      setActive((prev) => (prev === next ? prev : next));
    });
  }, [lines, synced, getPlaybackSample, enabled]);
  return active;
}
