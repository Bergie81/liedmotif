// @vitest-environment jsdom

// The star and the save picker both write a Track's Favorite and Saved flags.
// When the picker's result lands while a star answer is still on its way, that
// older answer must not overwrite the newer choice — success or failure.
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import type { PlayableTrack } from './playable-track';
import type { TrackRetentionFlags } from './track-retention';
import { useTrackActions, type TrackActionDeps } from './use-track-actions';

type FavoriteAnswer = { ok: true; data: TrackRetentionFlags } | { ok: false };

const pending: Array<(res: FavoriteAnswer) => void> = [];
const favoriteTrack = vi.fn(
  (_trackId: string, _favorited: boolean) =>
    new Promise<FavoriteAnswer>((resolve) => {
      pending.push(resolve);
    }),
);

vi.mock('@/lib/http/api-client', () => ({
  dislikeTrack: vi.fn(),
  deleteTrack: vi.fn(),
  favoriteTrack: (trackId: string, favorited: boolean) => favoriteTrack(trackId, favorited),
  sendFeedback: vi.fn(),
}));

afterEach(() => {
  cleanup();
  favoriteTrack.mockClear();
  pending.length = 0;
  toast.dismiss();
});

const SAVED = '2026-11-01T00:00:00.000Z';
const STARRED = '2026-11-19T10:00:00.000Z';

function setup(initial: TrackRetentionFlags = { savedAt: SAVED, favoritedAt: null }) {
  const track = {
    trackId: 'a',
    queueItemId: 'q-a',
    inCuratedPlaylist: false,
    ...initial,
  } as PlayableTrack;
  let starLit = initial.favoritedAt != null;
  const deps: TrackActionDeps = {
    sourceId: 's1',
    sessionId: 's1',
    activeTrack: () => track,
    patch: (next) => {
      starLit = next.currentFavorited;
    },
    markRemoved: vi.fn(),
    unmarkRemoved: vi.fn(),
    removeFromQueue: vi.fn(),
    advancePastCurrent: vi.fn(),
    queueChanged: vi.fn(),
  };
  const { result } = renderHook(() => useTrackActions(deps));
  return { actions: () => result.current, track, starLit: () => starLit };
}

async function answer(res: FavoriteAnswer) {
  await act(async () => {
    pending.shift()?.(res);
  });
}

describe('Favorite answer vs a newer picker commit', () => {
  it('a late Favorite answer does not overwrite a newer picker commit', async () => {
    const { actions, track, starLit } = setup();

    actions().toggleFavorite();
    actions().applyRetentionFlags('a', { savedAt: SAVED, favoritedAt: null }, true);
    await answer({ ok: true, data: { savedAt: SAVED, favoritedAt: STARRED } });

    expect(track.favoritedAt).toBeNull();
    expect(starLit()).toBe(false);
  });

  it('a late failed Favorite answer does not roll back a newer picker commit', async () => {
    const { actions, track, starLit } = setup({ savedAt: null, favoritedAt: null });

    actions().toggleFavorite();
    actions().applyRetentionFlags('a', { savedAt: SAVED, favoritedAt: STARRED }, false);
    await answer({ ok: false });

    expect(track.savedAt).toBe(SAVED);
    expect(track.favoritedAt).toBe(STARRED);
    expect(starLit()).toBe(true);
  });

  it('applies the server flags when nothing newer happened', async () => {
    const { actions, track, starLit } = setup();

    actions().toggleFavorite();
    await answer({ ok: true, data: { savedAt: SAVED, favoritedAt: STARRED } });

    expect(track.favoritedAt).toBe(STARRED);
    expect(starLit()).toBe(true);
  });

  it('restores the earlier state and shows the failure when nothing newer happened', async () => {
    const { actions, track, starLit } = setup();

    actions().toggleFavorite();
    await answer({ ok: false });

    expect(track.favoritedAt).toBeNull();
    expect(starLit()).toBe(false);
    expect(shownToasts().map((shown) => shown.message)).toEqual([
      'Favorite failed — this track was not starred. Try again.',
    ]);
  });

  it('a failed Favorite after an Assistant add rolls the star back and keeps what the Assistant saved', async () => {
    const { actions, track, starLit } = setup({ savedAt: null, favoritedAt: null });

    actions().toggleFavorite();
    actions().applyRetentionAdded('a', { favorited: false, curated: true });
    await answer({ ok: false });

    expect(track.favoritedAt).toBeNull();
    expect(track.savedAt).not.toBeNull();
    expect(track.inCuratedPlaylist).toBe(true);
    expect(starLit()).toBe(false);
  });

  it('a failed Unfavorite after the Assistant favorited the Track keeps the star lit', async () => {
    const { actions, track, starLit } = setup({ savedAt: SAVED, favoritedAt: STARRED });

    actions().toggleFavorite();
    actions().applyRetentionAdded('a', { favorited: true, curated: false });
    await answer({ ok: false });

    expect(track.favoritedAt).toBe(STARRED);
    expect(starLit()).toBe(true);
  });

  it('an Assistant add with no star answer on its way shows the Track as kept', () => {
    const { actions, track, starLit } = setup({ savedAt: null, favoritedAt: null });

    actions().applyRetentionAdded('a', { favorited: true, curated: false });

    expect(track.savedAt).not.toBeNull();
    expect(track.favoritedAt).not.toBeNull();
    expect(starLit()).toBe(true);
  });

  it('ignores a second star tap while the first is pending', () => {
    const { actions } = setup();

    actions().toggleFavorite();
    actions().toggleFavorite();

    expect(favoriteTrack).toHaveBeenCalledTimes(1);
  });
});
