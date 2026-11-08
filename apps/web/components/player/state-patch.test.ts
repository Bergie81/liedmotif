import { describe, expect, it } from 'vitest';
import { patchLeavesStateUnchanged } from './state-patch';

describe('patchLeavesStateUnchanged', () => {
  const state = {
    queueLength: 2,
    status: 'playing',
    playableQueueItemIds: ['a', 'b'],
    pendingGeneration: null as { stage: string } | null,
    queueItems: [{ id: 'a', track: { title: 'One', tags: ['lofi'] } }],
    vibe: { mood: 'calm' } as { mood: string } | null,
  };

  it('detects a structurally identical patch despite fresh object identities', () => {
    expect(
      patchLeavesStateUnchanged(state, {
        queueLength: 2,
        playableQueueItemIds: ['a', 'b'],
        queueItems: [{ id: 'a', track: { title: 'One', tags: ['lofi'] } }],
        vibe: { mood: 'calm' },
      }),
    ).toBe(true);
  });

  it('sees scalar, array, nested, and null-transition changes', () => {
    expect(patchLeavesStateUnchanged(state, { queueLength: 3 })).toBe(false);
    expect(patchLeavesStateUnchanged(state, { playableQueueItemIds: ['a'] })).toBe(false);
    expect(
      patchLeavesStateUnchanged(state, {
        queueItems: [{ id: 'a', track: { title: 'Renamed', tags: ['lofi'] } }],
      }),
    ).toBe(false);
    expect(patchLeavesStateUnchanged(state, { vibe: null })).toBe(false);
    expect(patchLeavesStateUnchanged(state, { pendingGeneration: { stage: 'queued' } })).toBe(
      false,
    );
  });

  it('only compares the keys the patch actually carries (a Playlist patch has no session signals)', () => {
    expect(patchLeavesStateUnchanged(state, { status: 'playing', queueLength: 2 })).toBe(true);
  });
});
