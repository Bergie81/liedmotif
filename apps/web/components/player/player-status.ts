// The queue-snapshot status recovery. Pure so the
// decision carries the coverage while the controller keeps only thin wiring
// (the resume-position pattern).

import type { PlayerStatus } from './playback-controller-api';

/**
 * The status a queue poll leaves the player in. Both preparing states — the
 * initial `loading` and the queue-exhausted `waiting` — resolve by whether a
 * startable track now sits at the (re-anchored) cursor: to `ready` when one
 * does, `waiting` otherwise. `startable` is cursor occupancy, NOT queue
 * length — after a play-out the parked cursor sits one past the buffered set,
 * and a poll that brings nothing new must keep "Preparing", never a Ready
 * whose Play starts nothing. Every other status carries live playback (or a
 * settled transport) and is owned by the playback handlers, not the poll.
 */
export function snapshotPlayerStatus(current: PlayerStatus, startable: boolean): PlayerStatus {
  if (current !== 'loading' && current !== 'waiting') return current;
  return startable ? 'ready' : 'waiting';
}

/**
 * What the play/pause toggle does. Beyond pausing live playback,
 * `pause` is also how a pending auto-start is DISARMED: with the deferred-play
 * intent armed and no track loaded yet (a preparing session), the button
 * cancels the pending start instead of re-arming it. Once a deck carries a
 * track (including after a browser-blocked auto-start left the player in
 * Ready), the button always plays — the armed flag alone must never turn the
 * visible Play button into a no-op pause.
 */
export function toggleIntent(
  status: PlayerStatus,
  wantPlay: boolean,
  hasDeckTrack: boolean,
): 'pause' | 'play' {
  if (status === 'playing') return 'pause';
  if (wantPlay && !hasDeckTrack) return 'pause';
  return 'play';
}

/**
 * Where a REJECTED `play()` promise leaves the player (browser autoplay
 * policy, an aborted load). A fresh start that never produced audio lands in
 * `ready` — a live Play button and a truthful "ready" readout, never a stuck
 * spinner or a phantom pause. A blocked RESUME keeps `paused`: the track was
 * genuinely underway and its position survives.
 */
export function rejectedPlayFallbackStatus(freshStart: boolean): PlayerStatus {
  return freshStart ? 'ready' : 'paused';
}
