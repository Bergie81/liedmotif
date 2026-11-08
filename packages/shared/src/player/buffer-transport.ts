// Buffer-transport decisions (the beat-locked tier).
//
// Pure logic for the `AudioBufferSourceNode` transport: the per-deck state
// machine (an `AudioBufferSourceNode` is one-shot, so pause/resume/seek are
// stop-node-record-offset-recreate operations, and a deliberate stop must be
// distinguishable from a natural `onended`), position bookkeeping against the
// AudioContext clock, the runtime qualification gate (deviceMemory / missing
// API ⇒ element decks — safe off, no UA sniffing), and the Media Session
// position-state mapping the player publishes from the context clock while a
// buffer deck is audible. The DOM/WebAudio driver executes the returned
// actions; keeping the decisions here is what makes the transport matrix
// testable with a stubbed context.

import { clamp } from './blend';

/** The transport state of one buffer deck. `paused` holds a recorded offset;
 *  the underlying source node is DEAD in every state but `playing` (one-shot
 *  nodes are recreated per start). */
export type BufferDeckState = 'idle' | 'playing' | 'paused';

/** Transport events. `stop` is a DELIBERATE stop (navigation, unload,
 *  cancellation) — never a natural end. `source-ended` is the source node's
 *  `onended`: natural ONLY while `playing`; in any other state it is the echo
 *  of a deliberate stop (or stale) and is ignored. */
export type BufferDeckEvent = 'start' | 'park' | 'pause' | 'resume' | 'stop' | 'source-ended';

/** What the driver must do alongside the state change. */
export type BufferDeckAction = 'start-source' | 'stop-source' | 'none';

export interface BufferDeckTransition {
  state: BufferDeckState;
  action: BufferDeckAction;
  /** True only when a `source-ended` arrived while `playing` — the track ran
   *  out naturally and the controller reports `ended` / advances. */
  naturalEnd: boolean;
}

/**
 * The buffer-deck transition table. Unknown (state, event) pairs are ignored
 * (state unchanged, no action) — a stale `onended` from a replaced source or a
 * double pause must never corrupt the transport.
 */
export function bufferDeckTransition(
  state: BufferDeckState,
  event: BufferDeckEvent,
): BufferDeckTransition {
  const ignore: BufferDeckTransition = { state, action: 'none', naturalEnd: false };
  switch (event) {
    case 'start':
      return state === 'idle'
        ? { state: 'playing', action: 'start-source', naturalEnd: false }
        : ignore;
    case 'park':
      return state === 'idle' ? { state: 'paused', action: 'none', naturalEnd: false } : ignore;
    case 'pause':
      return state === 'playing'
        ? { state: 'paused', action: 'stop-source', naturalEnd: false }
        : ignore;
    case 'resume':
      return state === 'paused'
        ? { state: 'playing', action: 'start-source', naturalEnd: false }
        : ignore;
    case 'stop':
      if (state === 'idle') return ignore;
      // A paused deck has no live source node to stop.
      return {
        state: 'idle',
        action: state === 'playing' ? 'stop-source' : 'none',
        naturalEnd: false,
      };
    case 'source-ended':
      return state === 'playing' ? { state: 'idle', action: 'none', naturalEnd: true } : ignore;
  }
}

/** A stretch of one buffer that its source repeats (a Section loop). */
export interface BufferLoopRegion {
  startSeconds: number;
  endSeconds: number;
}

/** The clock sample recorded when a buffer source is started: everything the
 *  exact position derives from (position bookkeeping + reports against
 *  the AudioContext clock). */
export interface BufferPlaybackClock {
  /** Context time passed to `source.start(when, offset)`. */
  startContextTime: number;
  /** Buffer offset passed to `start` (seconds of buffer content). */
  startOffsetSeconds: number;
  playbackRate: number;
  /** The region the source repeats; the offset must sit before its end. */
  loop?: BufferLoopRegion;
}

/** The exact buffer position at `nowContextTime`, clamped into the buffer.
 *  Before the scheduled start (armed, not yet audible) it holds at the offset. */
export function bufferPositionSeconds(
  clock: BufferPlaybackClock,
  nowContextTime: number,
  durationSeconds: number,
): number {
  const elapsed = Math.max(0, nowContextTime - clock.startContextTime) * clock.playbackRate;
  let position = clock.startOffsetSeconds + elapsed;
  const { loop } = clock;
  if (loop && position >= loop.endSeconds) {
    const span = loop.endSeconds - loop.startSeconds;
    position = loop.startSeconds + ((position - loop.startSeconds) % span);
  }
  return clamp(position, 0, durationSeconds);
}

/** Minimum `navigator.deviceMemory` (GiB) for buffer transport (a
 *  runtime safety gate; decoded finals cost ~100 MB of PCM per deck). */
export const BUFFER_DEVICE_MEMORY_MIN_GB = 4;

export interface BufferTransportGateInputs {
  /** The internal A/B flag — ships ON. */
  flagEnabled: boolean;
  /** A live AudioContext with `decodeAudioData` exists. */
  decodeSupported: boolean;
  /** `navigator.deviceMemory`, or null where the API is missing — missing API
   *  ⇒ element decks (safe off, no UA sniffing). */
  deviceMemoryGb: number | null;
}

/** Whether this session may use buffer transport at all. Per-edge checks
 *  (edge qualifies beat-locked, the finals actually decoded) come on top. */
export function bufferTransportEligible(inputs: BufferTransportGateInputs): boolean {
  return (
    inputs.flagEnabled &&
    inputs.decodeSupported &&
    inputs.deviceMemoryGb != null &&
    inputs.deviceMemoryGb >= BUFFER_DEVICE_MEMORY_MIN_GB
  );
}

/** Whether this device may run a Section loop. Unlike blend edges, a device that
 *  does not report its memory is allowed: the loop holds one decoded Track, not
 *  two, so only a known-small device is refused. */
export function sectionLoopEligible(inputs: BufferTransportGateInputs): boolean {
  return (
    inputs.flagEnabled &&
    inputs.decodeSupported &&
    (inputs.deviceMemoryGb == null || inputs.deviceMemoryGb >= BUFFER_DEVICE_MEMORY_MIN_GB)
  );
}

/** What `MediaSession.setPositionState` accepts. */
export interface MediaPositionState {
  duration: number;
  position: number;
  playbackRate: number;
}

/**
 * Map a playback clock sample to a publishable Media Session position state,
 * or null when nothing truthful can be published (no finite positive duration,
 * no position). Chrome THROWS on positions outside [0, duration], so the
 * position is clamped rather than trusted.
 */
export function mediaSessionPositionState(sample: {
  durationSeconds: number | null;
  positionSeconds: number | null;
  playbackRate: number;
}): MediaPositionState | null {
  const { durationSeconds, positionSeconds } = sample;
  if (
    durationSeconds == null ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    positionSeconds == null ||
    !Number.isFinite(positionSeconds)
  ) {
    return null;
  }
  const rate =
    Number.isFinite(sample.playbackRate) && sample.playbackRate > 0 ? sample.playbackRate : 1;
  return {
    duration: durationSeconds,
    position: clamp(positionSeconds, 0, durationSeconds),
    playbackRate: rate,
  };
}
