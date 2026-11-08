// Prepared-deck bookkeeping.
//
// The controller preloads the INACTIVE deck ahead of a transition: source set from
// the pinned-URL ladder, readiness awaited under a deadline, the fade scheduled,
// and the handoff committed. Every user action that invalidates the preparation
// (pause, skip, back, dislike, stop, source error, queue replacement) cancels it
// from whatever state it is in. This module is the pure transition table — the
// controller owns the timers, elements, and engine calls and executes the returned
// `action`; keeping the table pure is what makes the cancellation matrix testable
// without a DOM.

import type { CommittedSourceKind } from './edge-policy';

/** The pinned per-source URLs a queue item carries (`assets` on the queue contract). */
export interface PinnedAssets {
  final: string | null;
  stream: string | null;
}

/** One rung of the source ladder: a pinned URL and the kind it commits if it loads. */
export interface PinnedSourceStep {
  url: string;
  kind: CommittedSourceKind;
}

/**
 * The source ladder for a deck: pinned final first,
 * then pinned stream. The committed source kind IS the successful pinned URL's
 * asset — `HTMLMediaElement` exposes no response headers, so pinning is how the
 * player knows what it is playing. Decks never load unpinned URLs.
 */
export function pinnedSourceLadder(assets: PinnedAssets): PinnedSourceStep[] {
  const steps: PinnedSourceStep[] = [];
  if (assets.final) steps.push({ url: assets.final, kind: 'final' });
  if (assets.stream) steps.push({ url: assets.stream, kind: 'stream' });
  return steps;
}

export type PreparedDeckState = 'idle' | 'loading' | 'ready' | 'scheduled' | 'committed' | 'failed';

export type PreparedDeckEvent =
  | { type: 'prepare' }
  | { type: 'loaded' }
  /** The deck's pinned source ladder is EXHAUSTED (the per-deck ladder walk
   *  itself lives with the deck loader — it applies to active decks too, not
   *  only preparations). */
  | { type: 'load-error' }
  | { type: 'deadline' }
  | { type: 'schedule' }
  /** The incoming element's start never happened as scheduled: `play()` was
   *  rejected (autoplay/interruption policy), stayed pending past the miss
   *  window, or resolved too late to hold the alignment. */
  | { type: 'start-rejected' }
  | { type: 'commit' }
  | { type: 'cancel' };

/** What the driver must do alongside the state change. */
export type PreparedDeckAction = 'none' | 'abort-load' | 'cancel-schedule';

export interface PreparedDeckTransition {
  state: PreparedDeckState;
  action: PreparedDeckAction;
}

/**
 * The prepared-deck transition table. Unknown (state, event) pairs are ignored
 * (state unchanged, no action) — a late timer or a double event must never
 * corrupt the preparation.
 */
export function preparedDeckTransition(
  state: PreparedDeckState,
  event: PreparedDeckEvent,
): PreparedDeckTransition {
  switch (event.type) {
    case 'prepare':
      if (state === 'idle' || state === 'failed' || state === 'committed') {
        return { state: 'loading', action: 'none' };
      }
      return { state, action: 'none' };
    case 'loaded':
      return state === 'loading' ? { state: 'ready', action: 'none' } : { state, action: 'none' };
    case 'load-error':
      return state === 'loading'
        ? { state: 'failed', action: 'abort-load' }
        : { state, action: 'none' };
    case 'deadline':
      return state === 'loading'
        ? { state: 'failed', action: 'abort-load' }
        : { state, action: 'none' };
    case 'schedule':
      return state === 'ready' ? { state: 'scheduled', action: 'none' } : { state, action: 'none' };
    case 'start-rejected':
      return state === 'scheduled'
        ? { state: 'failed', action: 'cancel-schedule' }
        : { state, action: 'none' };
    case 'commit':
      return state === 'scheduled'
        ? { state: 'committed', action: 'none' }
        : { state, action: 'none' };
    case 'cancel':
      switch (state) {
        case 'loading':
        case 'ready':
          return { state: 'idle', action: 'abort-load' };
        case 'scheduled':
          return { state: 'idle', action: 'cancel-schedule' };
        default:
          return { state: 'idle', action: 'none' };
      }
  }
}
