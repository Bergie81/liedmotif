// @vitest-environment jsdom

// A Player write that did not land is an error toast like any other: it stays
// until it is closed, a second failure shows again after the first was closed,
// and trying the act again takes the old failure away.

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeToast, shownToasts, toast } from '@/lib/toast';
import type { PlayableTrack } from './playable-track';
import { useTrackActions } from './use-track-actions';

const api = vi.hoisted(() => ({
  favoriteTrack: vi.fn<(trackId: string, favorited: boolean) => Promise<{ ok: boolean }>>(),
  dislikeTrack: vi.fn<(trackId: string) => Promise<{ ok: boolean }>>(),
}));

vi.mock('@/lib/http/api-client', () => ({
  dislikeTrack: api.dislikeTrack,
  deleteTrack: vi.fn(),
  favoriteTrack: api.favoriteTrack,
  sendFeedback: vi.fn(),
}));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  act(() => toast.dismiss());
  act(() => vi.advanceTimersByTime(250));
  vi.useRealTimers();
  api.favoriteTrack.mockReset();
  api.dislikeTrack.mockReset();
});

const FAVORITE_FAILED = 'Favorite failed — this track was not starred. Try again.';
const DISLIKE_FAILED = 'Dislike failed — the track stays in your session. Try again.';

function setup() {
  const track = { trackId: 'a', queueItemId: 'q-a', savedAt: null, favoritedAt: null };
  const { result } = renderHook(() =>
    useTrackActions({
      sourceId: 'session-1',
      sessionId: 'session-1',
      activeTrack: () => track as unknown as PlayableTrack,
      patch: vi.fn(),
      markRemoved: vi.fn(),
      unmarkRemoved: vi.fn(),
      removeFromQueue: vi.fn(),
      advancePastCurrent: vi.fn(),
      queueChanged: vi.fn(),
    }),
  );
  return () => result.current;
}

const shownErrors = () =>
  shownToasts().flatMap((shown) => (shown.tone === 'error' ? [shown.message] : []));

async function favoriteFails(actions: () => ReturnType<typeof useTrackActions>) {
  api.favoriteTrack.mockResolvedValueOnce({ ok: false });
  await act(async () => actions().toggleFavorite());
}

it('keeps a failed write up until it is closed', async () => {
  const actions = setup();

  await favoriteFails(actions);
  act(() => vi.advanceTimersByTime(60_000));

  expect(shownErrors()).toEqual([FAVORITE_FAILED]);
});

it('shows the same failure again after the first was closed', async () => {
  const actions = setup();
  await favoriteFails(actions);
  act(() => closeToast(shownToasts()[0]!.id));

  await favoriteFails(actions);

  expect(shownErrors()).toEqual([FAVORITE_FAILED]);
});

it('takes a failure away when its act is tried again', async () => {
  const actions = setup();
  api.dislikeTrack.mockResolvedValueOnce({ ok: false });
  await act(async () => actions().dislike());
  expect(shownErrors()).toEqual([DISLIKE_FAILED]);

  api.dislikeTrack.mockReturnValueOnce(new Promise(() => undefined));
  act(() => actions().dislike());

  expect(shownErrors()).toEqual([]);
});
