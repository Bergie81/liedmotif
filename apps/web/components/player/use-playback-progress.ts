'use client';

import { useEffect, useState } from 'react';
import { playbackProgressPercent } from './player-presentation';
import type { PlaybackSample } from './playback-controller-api';
import { pollWhileVisible } from './visible-poll';

/** Poll the truthful playback clock into a 0–100 progress percentage while
 * `queueItemId` names an audible track; 0 otherwise. Position deliberately
 * stays out of shared render state (see `session-player-api`), so each
 * progress surface owns its poll at the rate its rendering deserves.
 * `knownDurationSeconds` is the queue's length for the track — the fallback
 * (then estimate) clock while a streaming source reports no duration. */
export function usePlaybackProgress(input: {
  getPlaybackSample: (() => PlaybackSample) | undefined;
  queueItemId: string | null;
  pollMs: number;
  knownDurationSeconds: number | null;
}): number {
  const { getPlaybackSample, queueItemId, pollMs, knownDurationSeconds } = input;
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!queueItemId || !getPlaybackSample) {
      setProgress(0);
      return;
    }
    return pollWhileVisible(pollMs, () =>
      setProgress(playbackProgressPercent(getPlaybackSample(), knownDurationSeconds)),
    );
  }, [queueItemId, getPlaybackSample, pollMs, knownDurationSeconds]);
  return progress;
}
