'use client';

// The session-start autoplay handoff. The
// "start session" click is the ONE user gesture the browser grants, but the
// player — and the deck elements the engine binds — mounts only after the
// create request resolves. So the gesture handler primes an engine here
// (AudioContext created + unlocked, no graph yet) and the freshly-mounted
// player adopts it when it first needs one. A module slot, not React state:
// the gesture fires in the create card, the adoption in the player, and no
// common ancestor should re-render over a plumbing concern.
//
// Engine creation stays OUT of mount effects (the StrictMode double-mount
// safety in `use-session-player`): priming happens in a gesture handler,
// which StrictMode never double-runs, and adoption consumes the slot so a
// remount can never share or revive a disposed engine.

import { PlayerEngine } from './audio-engine';

let primed: PlayerEngine | null = null;

/** Called synchronously inside the start-session click: create + unlock the
 * audio context so the later poll-driven auto-start rides this gesture's
 * activation. Idempotent while a primed engine is waiting. */
export function primePlayerAutoplay(): void {
  if (primed) {
    // Re-priming (a second start attempt) re-asserts the unlock instead of
    // piling up contexts.
    void primed.resume();
    return;
  }
  const engine = new PlayerEngine();
  engine.prime();
  primed = engine;
}

/** Take the primed engine (once); null when no gesture primed one — the
 * player then constructs its engine lazily on the first play gesture. */
export function adoptPrimedPlayerEngine(): PlayerEngine | null {
  const engine = primed;
  primed = null;
  return engine;
}
