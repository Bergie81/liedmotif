'use client';

// UI lifecycle for the cold-start progress surface. The scrubber consumes the
// resulting surface and fraction without owning a second set of timers and
// transitions alongside its playback clock and gesture state.

import { useEffect, useState } from 'react';
import {
  resolveColdStartSurface,
  syntheticProgressFraction,
  type ColdStartNarration,
  type ColdStartSurface,
} from './cold-start-progress';

const TICK_MS = 250;
const COMPLETE_HOLD_MS = 1400;

export function useColdStartProgress(
  staged: ColdStartNarration | null,
  playableExists: boolean,
): { surface: ColdStartSurface; fraction: number } {
  const [surface, setSurface] = useState<ColdStartSurface>({ kind: 'none' });
  const [fraction, setFraction] = useState(0);
  // The narration is derived fresh on every render of the caller, so the
  // surface transition must depend on its PRIMITIVES: a `staged` object
  // dependency would re-run the transition (and re-set state) every render.
  const copy = staged?.copy ?? null;
  const submittedAt = staged?.submittedAt ?? null;

  useEffect(() => {
    setSurface((previous) =>
      resolveColdStartSurface(
        previous,
        copy != null && submittedAt != null ? { copy, submittedAt } : null,
        playableExists,
      ),
    );
  }, [copy, submittedAt, playableExists]);

  useEffect(() => {
    if (surface.kind !== 'complete') return;
    const id = setTimeout(() => setSurface({ kind: 'none' }), COMPLETE_HOLD_MS);
    return () => clearTimeout(id);
  }, [surface.kind]);

  useEffect(() => {
    if (surface.kind !== 'staged') return;
    const submitted = Date.parse(surface.submittedAt);
    const tick = () => setFraction(syntheticProgressFraction(Date.now() - submitted));
    tick();
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [surface]);

  return { surface, fraction };
}
