'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { handoffFadeGains } from './player-provider-model';
import { SLEEP_TIMER_FADE_MS, sleepTimerEndsAt, type SleepTimerControl } from './sleep-timer';

/** What the timer stops: a hosted player controller's output and transport. */
export interface SleepTimerTarget {
  setOutputVolume: (volume: number) => void;
  pause: () => void;
}

const FADE_TICK_MS = 50;

/**
 * One wall-clock timer for whatever is playing. `getTargets` is read on every
 * fade step, not when the timer is set, so it silences the music playing THEN —
 * a source handed in mid-fade included. It pauses rather than stops: a
 * paused Session reports no playback, so it generates nothing, and stays
 * resumable where it left off.
 */
export function useSleepTimer(getTargets: () => SleepTimerTarget[]): SleepTimerControl {
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const getTargetsRef = useRef(getTargets);
  getTargetsRef.current = getTargets;

  useEffect(() => {
    if (endsAt === null) return;
    const fadeStartsAt = endsAt - SLEEP_TIMER_FADE_MS;
    let fading = false;
    let fadeId: ReturnType<typeof setInterval> | undefined;

    const step = () => {
      const targets = getTargetsRef.current();
      const fade = handoffFadeGains(Date.now() - fadeStartsAt, SLEEP_TIMER_FADE_MS);
      if (!fade.done) {
        for (const target of targets) target.setOutputVolume(fade.outgoing);
        return;
      }
      clearInterval(fadeId);
      fading = false;
      for (const target of targets) {
        target.pause();
        target.setOutputVolume(1);
      }
      setEndsAt(null);
    };

    const startId = setTimeout(
      () => {
        fading = true;
        step();
        fadeId = setInterval(step, FADE_TICK_MS);
      },
      Math.max(0, fadeStartsAt - Date.now()),
    );

    // Cancelled or replaced mid-fade: the music plays on at full level.
    return () => {
      clearTimeout(startId);
      clearInterval(fadeId);
      if (fading) for (const target of getTargetsRef.current()) target.setOutputVolume(1);
    };
  }, [endsAt]);

  const start = useCallback(
    (minutes: number) => setEndsAt(sleepTimerEndsAt(minutes, Date.now())),
    [],
  );
  const cancel = useCallback(() => setEndsAt(null), []);

  return useMemo(() => ({ endsAt, start, cancel }), [endsAt, start, cancel]);
}
