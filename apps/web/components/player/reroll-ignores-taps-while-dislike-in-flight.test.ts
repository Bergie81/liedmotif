// @vitest-environment jsdom

// Reroll advances at once, so a second tap before the first Dislike settles
// would reject the next, unheard Track — and with its sibling already disliked,
// buy a fresh generation. The guard lasts for the request only.
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayableTrack } from './playable-track';
import { useTrackActions, type TrackActionDeps } from './use-track-actions';

const pending: Array<(res: { ok: boolean }) => void> = [];
const dislikeTrack = vi.fn(
  (_trackId: string) =>
    new Promise<{ ok: boolean }>((resolve) => {
      pending.push(resolve);
    }),
);

vi.mock('@/lib/http/api-client', () => ({
  dislikeTrack: (trackId: string) => dislikeTrack(trackId),
  deleteTrack: vi.fn(),
  favoriteTrack: vi.fn(),
  sendFeedback: vi.fn(),
}));

afterEach(() => {
  cleanup();
  dislikeTrack.mockClear();
  pending.length = 0;
});

function setup() {
  const queue = ['a', 'b', 'c'];
  const deps: TrackActionDeps = {
    sourceId: 's1',
    sessionId: 's1',
    activeTrack: () =>
      queue[0] ? ({ trackId: queue[0], queueItemId: `q-${queue[0]}` } as PlayableTrack) : null,
    patch: vi.fn(),
    markRemoved: vi.fn(),
    unmarkRemoved: vi.fn(),
    removeFromQueue: vi.fn(),
    advancePastCurrent: () => {
      queue.shift();
    },
    queueChanged: vi.fn(),
  };
  const { result } = renderHook(() => useTrackActions(deps));
  return { actions: () => result.current };
}

async function settle(ok: boolean) {
  await act(async () => {
    pending.shift()?.({ ok });
  });
}

describe('Reroll double tap', () => {
  it('ignores a second tap while the first Dislike is in flight', () => {
    const { actions } = setup();

    actions().dislike();
    actions().dislike();

    expect(dislikeTrack.mock.calls.map(([id]) => id)).toEqual(['a']);
  });

  it('counts the next tap once the Dislike has settled, success or failure', async () => {
    const { actions } = setup();

    actions().dislike();
    await settle(true);
    actions().dislike();
    await settle(false);
    actions().dislike();

    expect(dislikeTrack.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c']);
  });
});
