import { describe, expect, it } from 'vitest';
import {
  IDLE_LOOP_CONTROL,
  loopControlTransition,
  loopToggledOn,
  type LoopControlState,
} from './loop-control';

// The repeat-one pin's decision table at the pure level — the controller hook
// executes the returned lease/target actions; these tests pin the decisions.

const PIN = { queueItemId: 'qi-current', trackId: 'track-current' };
const pinned: LoopControlState = { pinned: PIN, endAfterSeam: false };
const windingDown: LoopControlState = { pinned: PIN, endAfterSeam: true };

describe('loopControlTransition', () => {
  it('toggle-on pins the audible track, acquires the lease, and re-syncs the target', () => {
    const next = loopControlTransition(IDLE_LOOP_CONTROL, { type: 'toggle-on', track: PIN });
    expect(next.state).toEqual(pinned);
    expect(next.lease).toBe('acquire');
    expect(next.syncTarget).toBe(true);
    expect(loopToggledOn(next.state)).toBe(true);
  });

  it('toggle-off with no armed seam clears the pin, releases, and re-syncs', () => {
    const next = loopControlTransition(pinned, { type: 'toggle-off', seamArmed: false });
    expect(next.state).toEqual(IDLE_LOOP_CONTROL);
    expect(next.lease).toBe('release');
    expect(next.syncTarget).toBe(true);
  });

  it('toggle-off mid-armed-seam releases NOW but lets the seam complete (pin survives)', () => {
    const next = loopControlTransition(pinned, { type: 'toggle-off', seamArmed: true });
    expect(next.state).toEqual(windingDown);
    expect(next.lease).toBe('release');
    // The armed seam must complete: no target re-sync may cancel it.
    expect(next.syncTarget).toBe(false);
    expect(loopToggledOn(next.state)).toBe(false);
  });

  it('toggle-off while not pinned (or already winding down) is a no-op', () => {
    expect(
      loopControlTransition(IDLE_LOOP_CONTROL, { type: 'toggle-off', seamArmed: false }),
    ).toEqual({
      state: IDLE_LOOP_CONTROL,
      lease: null,
      syncTarget: false,
    });
    const again = loopControlTransition(windingDown, { type: 'toggle-off', seamArmed: true });
    expect(again.state).toEqual(windingDown);
    expect(again.lease).toBeNull();
  });

  it('a loop-pass commit of the pinned track keeps the pin (no lease traffic)', () => {
    const next = loopControlTransition(pinned, { type: 'committed', queueItemId: PIN.queueItemId });
    expect(next.state).toEqual(pinned);
    expect(next.lease).toBeNull();
    expect(next.syncTarget).toBe(false);
  });

  it('the pending toggle-off ends the pin at the seam commit (lease already released)', () => {
    const next = loopControlTransition(windingDown, {
      type: 'committed',
      queueItemId: PIN.queueItemId,
    });
    expect(next.state).toEqual(IDLE_LOOP_CONTROL);
    expect(next.lease).toBeNull();
  });

  it('a DIFFERENT track committing ends the pin and releases the lease', () => {
    const next = loopControlTransition(pinned, { type: 'committed', queueItemId: 'qi-other' });
    expect(next.state).toEqual(IDLE_LOOP_CONTROL);
    expect(next.lease).toBe('release');
  });

  it('a different track committing during wind-down does not release twice', () => {
    const next = loopControlTransition(windingDown, { type: 'committed', queueItemId: 'qi-other' });
    expect(next.state).toEqual(IDLE_LOOP_CONTROL);
    expect(next.lease).toBeNull();
  });

  it('commits while not pinned are no-ops', () => {
    expect(
      loopControlTransition(IDLE_LOOP_CONTROL, { type: 'committed', queueItemId: 'qi-x' }),
    ).toEqual({ state: IDLE_LOOP_CONTROL, lease: null, syncTarget: false });
  });

  it('exit (skip/dislike/Change Vibe/stop/source error) clears, releases, and re-syncs', () => {
    const next = loopControlTransition(pinned, { type: 'exit' });
    expect(next.state).toEqual(IDLE_LOOP_CONTROL);
    expect(next.lease).toBe('release');
    expect(next.syncTarget).toBe(true);
  });

  it('exit during wind-down clears without a second release', () => {
    const next = loopControlTransition(windingDown, { type: 'exit' });
    expect(next.state).toEqual(IDLE_LOOP_CONTROL);
    expect(next.lease).toBeNull();
  });

  it('exit while not pinned is a no-op', () => {
    expect(loopControlTransition(IDLE_LOOP_CONTROL, { type: 'exit' })).toEqual({
      state: IDLE_LOOP_CONTROL,
      lease: null,
      syncTarget: false,
    });
  });

  it('seam-cancelled ends ONLY a winding-down pin (pause kills the armed seam it waited on)', () => {
    const ended = loopControlTransition(windingDown, { type: 'seam-cancelled' });
    expect(ended.state).toEqual(IDLE_LOOP_CONTROL);
    expect(ended.lease).toBeNull(); // released at toggle-off already
    expect(ended.syncTarget).toBe(true);
    // A LIVE pin survives whatever cancelled the preparation (pause must never
    // end the loop) and re-prepares on the next tick.
    const live = loopControlTransition(pinned, { type: 'seam-cancelled' });
    expect(live.state).toEqual(pinned);
    expect(live.lease).toBeNull();
    expect(live.syncTarget).toBe(false);
  });

  it('re-pinning during wind-down keeps the loop and re-acquires the lease', () => {
    const next = loopControlTransition(windingDown, { type: 'toggle-on', track: PIN });
    expect(next.state).toEqual(pinned);
    expect(next.lease).toBe('acquire');
    expect(loopToggledOn(next.state)).toBe(true);
  });
});
