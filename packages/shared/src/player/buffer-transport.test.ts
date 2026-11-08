import { describe, expect, it } from 'vitest';
import {
  BUFFER_DEVICE_MEMORY_MIN_GB,
  bufferDeckTransition,
  bufferPositionSeconds,
  bufferTransportEligible,
  mediaSessionPositionState,
  sectionLoopEligible,
  type BufferDeckEvent,
  type BufferDeckState,
} from './buffer-transport';

// Buffer transport decisions: the deck state machine (explicit
// pause/resume via stop-and-recreate, deliberate stop vs natural source end),
// position bookkeeping against the AudioContext clock, the runtime gate
// (deviceMemory / missing API / flag), and the Media Session position-state
// mapping published from the context clock.

describe('bufferDeckTransition', () => {
  const table: Array<{
    state: BufferDeckState;
    event: BufferDeckEvent;
    next: BufferDeckState;
    action: 'start-source' | 'stop-source' | 'none';
    naturalEnd?: boolean;
  }> = [
    // The happy transport loop.
    { state: 'idle', event: 'start', next: 'playing', action: 'start-source' },
    { state: 'playing', event: 'pause', next: 'paused', action: 'stop-source' },
    { state: 'paused', event: 'resume', next: 'playing', action: 'start-source' },
    // Deliberate stop from every carrying state — never a natural end.
    { state: 'playing', event: 'stop', next: 'idle', action: 'stop-source' },
    { state: 'paused', event: 'stop', next: 'idle', action: 'none' },
    // Natural end: ONLY a source-ended while playing.
    { state: 'playing', event: 'source-ended', next: 'idle', action: 'none', naturalEnd: true },
    // Parking lands on a recorded offset with no source running.
    { state: 'idle', event: 'park', next: 'paused', action: 'none' },
    { state: 'playing', event: 'park', next: 'playing', action: 'none' },
    { state: 'paused', event: 'park', next: 'paused', action: 'none' },
    // Stale/duplicate events are ignored (state unchanged, no action).
    { state: 'idle', event: 'pause', next: 'idle', action: 'none' },
    { state: 'idle', event: 'resume', next: 'idle', action: 'none' },
    { state: 'idle', event: 'stop', next: 'idle', action: 'none' },
    { state: 'idle', event: 'source-ended', next: 'idle', action: 'none' },
    { state: 'paused', event: 'source-ended', next: 'paused', action: 'none' },
    { state: 'paused', event: 'pause', next: 'paused', action: 'none' },
    { state: 'playing', event: 'start', next: 'playing', action: 'none' },
    { state: 'playing', event: 'resume', next: 'playing', action: 'none' },
    { state: 'paused', event: 'start', next: 'paused', action: 'none' },
  ];

  it.each(table)('$state + $event → $next ($action)', (row) => {
    const t = bufferDeckTransition(row.state, row.event);
    expect(t.state).toBe(row.next);
    expect(t.action).toBe(row.action);
    expect(t.naturalEnd).toBe(row.naturalEnd ?? false);
  });
});

describe('bufferPositionSeconds', () => {
  const clock = { startContextTime: 100, startOffsetSeconds: 12, playbackRate: 1.01 };

  it('advances from the offset at the playback rate on the context clock', () => {
    expect(bufferPositionSeconds(clock, 110, 300)).toBeCloseTo(12 + 10 * 1.01, 10);
  });

  it('holds at the offset before the scheduled start (armed but not yet audible)', () => {
    expect(bufferPositionSeconds(clock, 99, 300)).toBe(12);
  });

  it('clamps to the buffer duration at the tail', () => {
    expect(bufferPositionSeconds(clock, 100_000, 300)).toBe(300);
  });

  it('never returns a negative position', () => {
    expect(
      bufferPositionSeconds(
        { startContextTime: 0, startOffsetSeconds: -5, playbackRate: 1 },
        1,
        30,
      ),
    ).toBe(0);
  });
});

describe('bufferTransportEligible (gating table incl. missing API)', () => {
  const eligible = { flagEnabled: true, decodeSupported: true, deviceMemoryGb: 8 };

  it('passes when the flag is on, decode is supported, and deviceMemory ≥ 4', () => {
    expect(bufferTransportEligible(eligible)).toBe(true);
    expect(
      bufferTransportEligible({ ...eligible, deviceMemoryGb: BUFFER_DEVICE_MEMORY_MIN_GB }),
    ).toBe(true);
  });

  it('a MISSING deviceMemory API is safe-off (element decks, no UA sniffing)', () => {
    expect(bufferTransportEligible({ ...eligible, deviceMemoryGb: null })).toBe(false);
  });

  it('a low-memory device stays on element decks', () => {
    expect(bufferTransportEligible({ ...eligible, deviceMemoryGb: 2 })).toBe(false);
  });

  it('missing decode support is safe-off', () => {
    expect(bufferTransportEligible({ ...eligible, decodeSupported: false })).toBe(false);
  });

  it('the internal flag can switch the tier off (ships ON by default)', () => {
    expect(bufferTransportEligible({ ...eligible, flagEnabled: false })).toBe(false);
  });
});

describe('mediaSessionPositionState', () => {
  it('maps a live buffer clock sample to a publishable position state', () => {
    expect(
      mediaSessionPositionState({
        durationSeconds: 200,
        positionSeconds: 42.5,
        playbackRate: 1.01,
      }),
    ).toEqual({ duration: 200, position: 42.5, playbackRate: 1.01 });
  });

  it('clamps the position into [0, duration] (a lying position state throws in Chrome)', () => {
    expect(
      mediaSessionPositionState({ durationSeconds: 200, positionSeconds: 220, playbackRate: 1 }),
    ).toEqual({ duration: 200, position: 200, playbackRate: 1 });
    expect(
      mediaSessionPositionState({ durationSeconds: 200, positionSeconds: -1, playbackRate: 1 }),
    ).toEqual({ duration: 200, position: 0, playbackRate: 1 });
  });

  it('returns null (publish nothing) without a finite positive duration or position', () => {
    expect(
      mediaSessionPositionState({ durationSeconds: null, positionSeconds: 10, playbackRate: 1 }),
    ).toBeNull();
    expect(
      mediaSessionPositionState({ durationSeconds: NaN, positionSeconds: 10, playbackRate: 1 }),
    ).toBeNull();
    expect(
      mediaSessionPositionState({ durationSeconds: 0, positionSeconds: 0, playbackRate: 1 }),
    ).toBeNull();
    expect(
      mediaSessionPositionState({ durationSeconds: 100, positionSeconds: null, playbackRate: 1 }),
    ).toBeNull();
  });

  it('falls back to rate 1 when the rate is unusable', () => {
    expect(
      mediaSessionPositionState({ durationSeconds: 100, positionSeconds: 1, playbackRate: 0 }),
    ).toEqual({ duration: 100, position: 1, playbackRate: 1 });
  });
});

describe('bufferPositionSeconds with a section loop', () => {
  const clock = {
    startContextTime: 100,
    startOffsetSeconds: 10,
    playbackRate: 1,
    loop: { startSeconds: 10, endSeconds: 14 },
  };

  it('counts straight through until the loop end', () => {
    expect(bufferPositionSeconds(clock, 103, 30)).toBeCloseTo(13);
  });

  it('wraps back to the loop start at the end', () => {
    expect(bufferPositionSeconds(clock, 104, 30)).toBeCloseTo(10);
    expect(bufferPositionSeconds(clock, 105.5, 30)).toBeCloseTo(11.5);
  });

  it('stays on the loop across many passes', () => {
    expect(bufferPositionSeconds(clock, 100 + 4 * 250 + 1, 30)).toBeCloseTo(11);
  });

  it('plays into the loop from a start before it', () => {
    const before = { ...clock, startOffsetSeconds: 8 };
    expect(bufferPositionSeconds(before, 101, 30)).toBeCloseTo(9);
    expect(bufferPositionSeconds(before, 106, 30)).toBeCloseTo(10);
    expect(bufferPositionSeconds(before, 107, 30)).toBeCloseTo(11);
  });

  it('measures buffer time, not wall time, at another playback rate', () => {
    expect(bufferPositionSeconds({ ...clock, playbackRate: 2 }, 103, 30)).toBeCloseTo(12);
  });

  it('holds at the offset before the scheduled start', () => {
    expect(bufferPositionSeconds(clock, 99, 30)).toBeCloseTo(10);
  });
});

describe('sectionLoopEligible', () => {
  const ok = { flagEnabled: true, decodeSupported: true };

  it('allows a device that does not report its memory', () => {
    expect(sectionLoopEligible({ ...ok, deviceMemoryGb: null })).toBe(true);
  });

  it('allows the buffer minimum and refuses a device reporting less', () => {
    expect(sectionLoopEligible({ ...ok, deviceMemoryGb: 4 })).toBe(true);
    expect(sectionLoopEligible({ ...ok, deviceMemoryGb: 2 })).toBe(false);
  });

  it('needs the transport flag and a decoding context', () => {
    expect(sectionLoopEligible({ ...ok, flagEnabled: false, deviceMemoryGb: 8 })).toBe(false);
    expect(sectionLoopEligible({ ...ok, decodeSupported: false, deviceMemoryGb: 8 })).toBe(false);
  });
});
