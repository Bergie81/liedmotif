// Repeat-one loop control.
//
// The Now Playing loop toggle PINS the audible track: every natural advance
// re-targets it (the seam is an ordinary prepared-deck edge whose target is
// the pinned track itself), and a server-side loop LEASE holds paid prefill
// while the pin is on. This module is the pure decision table for the pin's
// lifecycle — the controller hook executes the returned actions (lease
// acquire/release, prepared-target re-sync); keeping it pure is what makes
// its rules testable without a DOM.
//
// Rules:
// - Toggle-on pins the audible track and ACQUIRES the lease (acknowledged).
// - Toggle-off RELEASES the lease immediately; an ARMED (scheduled) seam
//   completes first — the pin survives until that seam's commit — while an
//   unarmed preparation is cancelled via a target re-sync.
// - Every path that makes a DIFFERENT track current (skip, dislike, Back to
//   previous, source failure, queue replacement) ends the pin: the commit
//   event compares the committed queue item against the pin.
// - Explicit exits (skip, dislike, Change Vibe, stop/session end, source
//   error) clear the pin and release the lease even when no new track will
//   commit (e.g. the queue is exhausted).

/** The pinned track's identity (the queue slot is what commits compare against). */
export interface LoopPin {
  queueItemId: string;
  trackId: string;
}

export interface LoopControlState {
  pinned: LoopPin | null;
  /** Toggle-off landed while a seam was ARMED: the seam completes, then the pin ends. */
  endAfterSeam: boolean;
}

export const IDLE_LOOP_CONTROL: LoopControlState = { pinned: null, endAfterSeam: false };

export type LoopControlEvent =
  /** The user pressed the toggle on (only offered while the committed source is a final). */
  | { type: 'toggle-on'; track: LoopPin }
  /** The user pressed the toggle off. `seamArmed` = a seam for the pinned track
   *  is SCHEDULED (its fade automation is armed) — it completes before the pin ends. */
  | { type: 'toggle-off'; seamArmed: boolean }
  /** A logical handoff committed (seam replay, advance, or explicit navigation). */
  | { type: 'committed'; queueItemId: string }
  /** The ARMED seam a wind-down was waiting on is gone (pause cancels every
   *  preparation): a pin kept alive only for that seam ends now — a LIVE pin
   *  is unaffected (pause must never end the loop). */
  | { type: 'seam-cancelled' }
  /** An explicit loop exit: skip, dislike, Change Vibe, stop/session end, source error. */
  | { type: 'exit' };

export interface LoopControlTransition {
  state: LoopControlState;
  /** Lease side effect the driver must perform against the acknowledged endpoint. */
  lease: 'acquire' | 'release' | null;
  /** Re-sync the prepared-deck target now (cancels a preparation this change obsoletes). */
  syncTarget: boolean;
}

/** Whether the toggle renders as ON (pressed): pinned and not winding down. */
export function loopToggledOn(state: LoopControlState): boolean {
  return state.pinned != null && !state.endAfterSeam;
}

/**
 * The loop-control transition table. Unknown/no-op (state, event) pairs return
 * the state unchanged with no actions — a late or duplicate event must never
 * corrupt the pin or leak a lease operation.
 */
export function loopControlTransition(
  state: LoopControlState,
  event: LoopControlEvent,
): LoopControlTransition {
  switch (event.type) {
    case 'toggle-on':
      // Re-pinning while a toggle-off winds down (endAfterSeam) simply keeps
      // the loop: the pin refreshes and the lease is re-acquired.
      return {
        state: { pinned: event.track, endAfterSeam: false },
        lease: 'acquire',
        syncTarget: true,
      };
    case 'toggle-off': {
      if (!loopToggledOn(state)) return { state, lease: null, syncTarget: false };
      // The lease releases NOW either way — prefill resumes within one sweep
      // tick; only the audible seam is allowed to finish what it armed.
      if (event.seamArmed) {
        return {
          state: { pinned: state.pinned, endAfterSeam: true },
          lease: 'release',
          syncTarget: false,
        };
      }
      return { state: IDLE_LOOP_CONTROL, lease: 'release', syncTarget: true };
    }
    case 'committed': {
      if (!state.pinned) return { state, lease: null, syncTarget: false };
      if (event.queueItemId === state.pinned.queueItemId) {
        // A loop pass replayed the pinned track. A pending toggle-off ends the
        // pin here (its lease was already released); otherwise the pin holds.
        return {
          state: state.endAfterSeam ? IDLE_LOOP_CONTROL : state,
          lease: null,
          syncTarget: false,
        };
      }
      // A DIFFERENT track became current: the pin is over. Release the lease
      // unless a toggle-off already did.
      return {
        state: IDLE_LOOP_CONTROL,
        lease: state.endAfterSeam ? null : 'release',
        syncTarget: false,
      };
    }
    case 'seam-cancelled': {
      // Only a WINDING-DOWN pin dies with its seam (the lease was already
      // released at toggle-off); a live pin survives whatever cancelled the
      // preparation and re-prepares on the next tick.
      return state.endAfterSeam
        ? { state: IDLE_LOOP_CONTROL, lease: null, syncTarget: true }
        : { state, lease: null, syncTarget: false };
    }
    case 'exit': {
      if (!state.pinned) return { state, lease: null, syncTarget: false };
      return {
        state: IDLE_LOOP_CONTROL,
        lease: state.endAfterSeam ? null : 'release',
        syncTarget: true,
      };
    }
  }
}
