'use client';

// Server-seeded client controllers: pages pass the first load's data as a prop,
// so the controller's FIRST load effect must not refetch what the render
// already carries — while every later run (search change, reload counter,
// remount after the seed is spent) fetches as usual.

import { useCallback, useRef } from 'react';

/** A consume-once probe for the seed: true exactly once when server data
 * seeded the state, false ever after. Call it at the top of the load effect:
 * `if (consumeServerSeed()) return;`. */
export function useServerSeed(seeded: boolean): () => boolean {
  const seededRef = useRef(seeded);
  return useCallback(() => {
    const wasSeeded = seededRef.current;
    seededRef.current = false;
    return wasSeeded;
  }, []);
}
