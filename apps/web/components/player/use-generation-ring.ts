'use client';

import { useEffect, useState } from 'react';

/** A run with nothing landed yet still shows that it has begun. */
const RING_START_FRACTION = 0.06;
/** How long the completed ring stays up after the last Track lands. */
const RING_HOLD_MS = 900;

/** One run of generation: every Track it has ordered, and those not landed yet. */
interface GenerationRun {
  total: number;
  ahead: number;
  /** The newest playable Track seen, which later arrivals are counted after. */
  newest: string | null;
}

const NO_RUN: GenerationRun = { total: 0, ahead: 0, newest: null };

/** Only Tracks after the last-seen newest are arrivals: the Queue window can also
 *  bring back older ones, and the seen one can have left. */
function tracksLanded(playableTracks: readonly string[], seenNewest: string | null): number {
  if (seenNewest === null) return 0;
  const seenAt = playableTracks.lastIndexOf(seenNewest);
  return seenAt === -1 ? 0 : playableTracks.length - 1 - seenAt;
}

function advanceRun(
  run: GenerationRun,
  ahead: number,
  playableTracks: readonly string[],
): GenerationRun {
  const newest = playableTracks.at(-1) ?? null;
  if (ahead === run.ahead && newest === run.newest) return run;
  if (ahead === 0) return { ...run, ahead, newest };
  if (run.ahead === 0) return { total: ahead, ahead, newest };
  const ordered = ahead - run.ahead + tracksLanded(playableTracks, run.newest);
  return { total: run.total + Math.max(ordered, 0), ahead, newest };
}

export interface GenerationRing {
  shown: boolean;
  /** How much of the ring is lit, 0–1. */
  fraction: number;
}

/**
 * The ring fills per Track landed in the current run. The player only reads
 * snapshots, so a batch can land and its refill start between two of them with
 * the count on the way unchanged; arrivals are therefore read from the playable
 * Tracks, and a run's size is remembered from what has been seen since it began.
 */
export function useGenerationRing(
  generatingAhead: number,
  playableTracks: readonly string[],
): GenerationRing {
  const [stored, setStored] = useState(() => advanceRun(NO_RUN, generatingAhead, playableTracks));
  const run = advanceRun(stored, generatingAhead, playableTracks);
  if (run !== stored) setStored(run);

  const completed = run.total > 0 && run.ahead === 0;
  useEffect(() => {
    if (!completed) return;
    const id = setTimeout(() => setStored((current) => ({ ...current, total: 0 })), RING_HOLD_MS);
    return () => clearTimeout(id);
  }, [completed]);

  if (run.total === 0) return { shown: false, fraction: 0 };
  return {
    shown: true,
    fraction: Math.max(RING_START_FRACTION, (run.total - run.ahead) / run.total),
  };
}
