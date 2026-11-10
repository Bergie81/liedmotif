'use client';

// Starting a Session from a click, wherever the click is: Home's Start button
// and a card confirmed in the Assistant's chat run this one flow. The request
// rides the session handoff and the app goes to /player at once, where the
// connecting state and the outcome are narrated.

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { usePlayerActions } from './player-provider';
import { beginPendingStart, type PendingStart } from './session-handoff';

type StartResult = PendingStart['result'];

/**
 * What to call inside the click with the request to send. Returns that
 * request's result, or null when another Start is still in flight: `start` was
 * not called then, and the app only returns to the Player that narrates it.
 */
export function useHandOffStart(): (
  start: (signal: AbortSignal) => StartResult,
) => StartResult | null {
  const router = useRouter();
  const { engage, beginStart } = usePlayerActions();
  return useCallback(
    (start) => {
      let result: StartResult | null = null;
      beginPendingStart(
        (signal) => {
          // The click is the browser's autoplay gesture, so priming and
          // request creation stay synchronous with this callback.
          beginStart();
          result = start(signal);
          return result;
        },
        (session) => engage(session, { autoplay: true }),
      );
      router.push('/player');
      return result;
    },
    [router, engage, beginStart],
  );
}
