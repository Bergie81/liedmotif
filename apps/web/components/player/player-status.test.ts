// The queue-snapshot status recovery: every
// preparing state — the initial `loading` AND the queue-exhausted `waiting` —
// must leave the spinner the moment a startable track arrives; states that
// carry live playback are never touched by a poll.

import { describe, expect, it } from 'vitest';
import { rejectedPlayFallbackStatus, snapshotPlayerStatus, toggleIntent } from './player-status';

describe('snapshotPlayerStatus', () => {
  it('recovers a waiting player to ready when the poll delivers a startable track', () => {
    // The reproduction: player parked in `waiting` (queue exhausted), the next
    // poll delivers the first playable track at the cursor.
    expect(snapshotPlayerStatus('waiting', true)).toBe('ready');
  });

  it('keeps waiting while no startable track sits at the cursor', () => {
    // A played-out projection with nothing new: the parked cursor points one
    // past the buffered set — Ready would offer a Play that starts nothing.
    expect(snapshotPlayerStatus('waiting', false)).toBe('waiting');
  });

  it('resolves the initial load to ready or waiting by track availability', () => {
    expect(snapshotPlayerStatus('loading', true)).toBe('ready');
    expect(snapshotPlayerStatus('loading', false)).toBe('waiting');
  });

  it('never touches states that carry live playback or a settled transport', () => {
    for (const status of ['ready', 'playing', 'paused', 'ended'] as const) {
      expect(snapshotPlayerStatus(status, true)).toBe(status);
      expect(snapshotPlayerStatus(status, false)).toBe(status);
    }
  });
});

// The play/pause toggle during a preparing session, with the
// deferred-play intent armed (auto-start, or Play pressed early).
describe('toggleIntent', () => {
  it('pauses live playback', () => {
    expect(toggleIntent('playing', false, true)).toBe('pause');
  });

  it('disarms a pending auto-start: armed intent with nothing loaded toggles to pause', () => {
    expect(toggleIntent('waiting', true, false)).toBe('pause');
    expect(toggleIntent('loading', true, false)).toBe('pause');
  });

  it('plays whenever a track is loaded but not playing — even with the intent still armed', () => {
    // After a browser-blocked auto-start the deck carries the track and the
    // player shows Ready: the Play button must PLAY, never disarm.
    expect(toggleIntent('ready', true, true)).toBe('play');
    expect(toggleIntent('paused', false, true)).toBe('play');
    expect(toggleIntent('waiting', false, false)).toBe('play');
  });
});

describe('rejectedPlayFallbackStatus', () => {
  it('a blocked FRESH start lands in ready (live Play button, no stuck spinner)', () => {
    expect(rejectedPlayFallbackStatus(true)).toBe('ready');
  });

  it('a blocked resume keeps the paused state it interrupted', () => {
    expect(rejectedPlayFallbackStatus(false)).toBe('paused');
  });
});
