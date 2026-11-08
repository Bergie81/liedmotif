import { describe, expect, it } from 'vitest';
import {
  pinnedSourceLadder,
  preparedDeckTransition,
  type PreparedDeckState,
} from './prepared-deck';

describe('pinnedSourceLadder', () => {
  it('tries the pinned final first, then the pinned stream', () => {
    expect(
      pinnedSourceLadder({
        final: '/api/audio/t?asset=final',
        stream: '/api/audio/t?asset=stream',
      }),
    ).toEqual([
      { url: '/api/audio/t?asset=final', kind: 'final' },
      { url: '/api/audio/t?asset=stream', kind: 'stream' },
    ]);
  });

  it('skips assets that do not exist', () => {
    expect(pinnedSourceLadder({ final: null, stream: '/api/audio/t?asset=stream' })).toEqual([
      { url: '/api/audio/t?asset=stream', kind: 'stream' },
    ]);
    expect(pinnedSourceLadder({ final: null, stream: null })).toEqual([]);
  });
});

describe('preparedDeckTransition', () => {
  it('walks the happy path: prepare → loaded → schedule → commit', () => {
    let t = preparedDeckTransition('idle', { type: 'prepare' });
    expect(t).toEqual({ state: 'loading', action: 'none' });
    t = preparedDeckTransition(t.state, { type: 'loaded' });
    expect(t).toEqual({ state: 'ready', action: 'none' });
    t = preparedDeckTransition(t.state, { type: 'schedule' });
    expect(t).toEqual({ state: 'scheduled', action: 'none' });
    t = preparedDeckTransition(t.state, { type: 'commit' });
    expect(t).toEqual({ state: 'committed', action: 'none' });
  });

  it('fails when the source ladder is exhausted while loading', () => {
    expect(preparedDeckTransition('loading', { type: 'load-error' })).toEqual({
      state: 'failed',
      action: 'abort-load',
    });
  });

  it('fails when the readiness deadline passes while still loading', () => {
    expect(preparedDeckTransition('loading', { type: 'deadline' })).toEqual({
      state: 'failed',
      action: 'abort-load',
    });
  });

  it('ignores a deadline that fires after readiness', () => {
    for (const state of ['ready', 'scheduled', 'committed'] as PreparedDeckState[]) {
      expect(preparedDeckTransition(state, { type: 'deadline' })).toEqual({
        state,
        action: 'none',
      });
    }
  });

  it('cancels from EVERY state (pause/skip/back/dislike/stop/error/queue-replacement)', () => {
    expect(preparedDeckTransition('idle', { type: 'cancel' })).toEqual({
      state: 'idle',
      action: 'none',
    });
    expect(preparedDeckTransition('loading', { type: 'cancel' })).toEqual({
      state: 'idle',
      action: 'abort-load',
    });
    expect(preparedDeckTransition('ready', { type: 'cancel' })).toEqual({
      state: 'idle',
      action: 'abort-load',
    });
    expect(preparedDeckTransition('scheduled', { type: 'cancel' })).toEqual({
      state: 'idle',
      action: 'cancel-schedule',
    });
    expect(preparedDeckTransition('committed', { type: 'cancel' })).toEqual({
      state: 'idle',
      action: 'none',
    });
    expect(preparedDeckTransition('failed', { type: 'cancel' })).toEqual({
      state: 'idle',
      action: 'none',
    });
  });

  it('fails a scheduled edge whose incoming start was rejected, settling the graph', () => {
    expect(preparedDeckTransition('scheduled', { type: 'start-rejected' })).toEqual({
      state: 'failed',
      action: 'cancel-schedule',
    });
    // Anywhere else a late rejection is a no-op.
    expect(preparedDeckTransition('idle', { type: 'start-rejected' })).toEqual({
      state: 'idle',
      action: 'none',
    });
  });

  it('allows a fresh preparation after a failure or a completed handoff', () => {
    expect(preparedDeckTransition('failed', { type: 'prepare' })).toEqual({
      state: 'loading',
      action: 'none',
    });
    expect(preparedDeckTransition('committed', { type: 'prepare' })).toEqual({
      state: 'loading',
      action: 'none',
    });
  });

  it('ignores events that do not apply to the current state', () => {
    expect(preparedDeckTransition('idle', { type: 'loaded' })).toEqual({
      state: 'idle',
      action: 'none',
    });
    expect(preparedDeckTransition('ready', { type: 'commit' })).toEqual({
      state: 'ready',
      action: 'none',
    });
    expect(preparedDeckTransition('failed', { type: 'schedule' })).toEqual({
      state: 'failed',
      action: 'none',
    });
  });
});
