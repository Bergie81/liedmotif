import { describe, expect, it } from 'vitest';
import {
  commitShuffleTarget,
  createShuffleState,
  cyclePlaybackMode,
  peekShuffleTarget,
  popShuffleHistory,
  removeShuffleTrack,
  resolveOrderedNextIndex,
  syncShuffleState,
} from './playback-mode';

function randomSequence(...values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? 0;
}

describe('playback modes', () => {
  it('cycles Loop Session → Loop Track → Shuffle Session', () => {
    expect(cyclePlaybackMode('loop-session')).toBe('loop-track');
    expect(cyclePlaybackMode('loop-track')).toBe('shuffle');
    expect(cyclePlaybackMode('shuffle')).toBe('loop-session');
  });

  it('wraps ordered playback without inventing a target for an empty queue', () => {
    expect(resolveOrderedNextIndex(3, 0)).toBe(1);
    expect(resolveOrderedNextIndex(3, 2)).toBe(0);
    expect(resolveOrderedNextIndex(3, -1)).toBe(0);
    expect(resolveOrderedNextIndex(0, 0)).toBeNull();
  });
});

describe('shuffle traversal', () => {
  it('draws every other playable track before reshuffling without an immediate repeat', () => {
    let state = createShuffleState(['a', 'b', 'c'], 'a', randomSequence(0.9, 0.1));

    let next = peekShuffleTarget(state, ['a', 'b', 'c'], 'a', randomSequence());
    state = next.state;
    expect(next.queueItemId).not.toBe('a');
    const first = next.queueItemId!;
    state = commitShuffleTarget(state, 'a', first);

    next = peekShuffleTarget(state, ['a', 'b', 'c'], first, randomSequence());
    state = next.state;
    expect(next.queueItemId).not.toBe(first);
    expect(new Set([first, next.queueItemId])).toEqual(new Set(['b', 'c']));
    const second = next.queueItemId!;
    state = commitShuffleTarget(state, first, second);

    next = peekShuffleTarget(state, ['a', 'b', 'c'], second, randomSequence(0.4, 0.8));
    expect(next.queueItemId).not.toBe(second);
  });

  it('inserts newly playable tracks into a random remaining-bag position', () => {
    const initial = createShuffleState(['a', 'b'], 'a', randomSequence(0));
    const synced = syncShuffleState(initial, ['a', 'b', 'c'], 'a', randomSequence(0));
    expect(synced.bag).toEqual(['c', 'b']);
    expect(synced.knownQueueItemIds).toEqual(['a', 'b', 'c']);
  });

  it('walks actual play history on Back and makes the departed current track next again', () => {
    let state = createShuffleState(['a', 'b', 'c'], 'a', randomSequence(0));
    state = commitShuffleTarget(state, 'a', 'b');
    state = commitShuffleTarget(state, 'b', 'c');

    const back = popShuffleHistory(state, ['a', 'b', 'c'], 'c');
    expect(back.queueItemId).toBe('b');
    expect(back.state.bag[0]).toBe('c');

    const again = popShuffleHistory(back.state, ['a', 'b', 'c'], 'b');
    expect(again.queueItemId).toBe('a');
  });

  it('removes unavailable tracks from the bag, history, and known playable set', () => {
    let state = createShuffleState(['a', 'b', 'c'], 'a', randomSequence(0));
    state = commitShuffleTarget(state, 'a', 'b');

    expect(removeShuffleTrack(state, 'a')).toEqual({
      bag: ['c'],
      history: [],
      knownQueueItemIds: ['b', 'c'],
    });
  });
});
