// @vitest-environment jsdom

// The player after the Assistant changed something it shows: the star of the
// Track on the deck, and the New music setting of the engaged Session.

import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePlayerFollowsReceipt } from './use-player-follows-receipt';

const TRACK_ID = '0c9d4b7a-8a41-4b0e-b1a3-5a2d9d6c7e22';
const SESSION_ID = '5d2f8e1b-6c3a-4f7e-8b9d-1a2b3c4d5e6f';
const OTHER_ID = '1d0e5c8b-9b52-4c1f-a2b4-6b3e0e7d8f33';
const FAVORITES = { id: '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f', name: 'Favorites' };

const player = vi.hoisted(() => ({
  context: null as unknown,
}));
vi.mock('@/components/player/player-provider', () => ({
  usePlayerContext: () => player.context,
}));

/** A Session playing `TRACK_ID`, saved long ago and in a hand-picked Playlist. */
function playing() {
  const applyRetentionFlags = vi.fn();
  const engage = vi.fn();
  const session = { id: SESSION_ID, title: 'Rainy Window', sessionMode: 'keep_going' };
  player.context = {
    engage,
    playback: {
      session,
      player: {
        currentTrack: {
          trackId: TRACK_ID,
          savedAt: '2026-01-01T00:00:00.000Z',
          favoritedAt: null,
          inCuratedPlaylist: true,
        },
        applyRetentionFlags,
      },
    },
  };
  return { applyRetentionFlags, engage, session };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the player, after a receipt', () => {
  it('lights the star of the Track on the deck when that Track was favorited', () => {
    vi.useFakeTimers({ now: new Date('2026-11-10T12:00:00.000Z') });
    const { applyRetentionFlags } = playing();
    const { result } = renderHook(() => usePlayerFollowsReceipt(vi.fn()));

    result.current({
      action: 'favoriteTrack',
      track: { id: TRACK_ID, name: 'Night Drive' },
      playlist: FAVORITES,
    });

    expect(applyRetentionFlags).toHaveBeenCalledWith(
      TRACK_ID,
      { savedAt: '2026-01-01T00:00:00.000Z', favoritedAt: '2026-11-10T12:00:00.000Z' },
      true,
    );
  });

  it('leaves the deck alone when another Track was favorited', () => {
    const { applyRetentionFlags } = playing();
    const { result } = renderHook(() => usePlayerFollowsReceipt(vi.fn()));

    result.current({
      action: 'favoriteTrack',
      track: { id: OTHER_ID, name: 'Tempo' },
      playlist: FAVORITES,
    });

    expect(applyRetentionFlags).not.toHaveBeenCalled();
  });

  it('shows New music off on the engaged Session without restarting it, and re-reads the shell', () => {
    const { engage, session } = playing();
    const refreshChrome = vi.fn();
    const { result } = renderHook(() => usePlayerFollowsReceipt(refreshChrome));

    result.current({ action: 'newMusicOff', session: { id: SESSION_ID, name: 'Rainy Window' } });

    expect(engage).toHaveBeenCalledWith({ ...session, sessionMode: 'repeat' }, { autoplay: false });
    expect(refreshChrome).toHaveBeenCalledTimes(1);
  });

  it('leaves the engaged Session alone when New music went off for another one', () => {
    const { engage } = playing();
    const refreshChrome = vi.fn();
    const { result } = renderHook(() => usePlayerFollowsReceipt(refreshChrome));

    result.current({ action: 'newMusicOff', session: { id: OTHER_ID, name: 'Elsewhere' } });

    expect(engage).not.toHaveBeenCalled();
    expect(refreshChrome).toHaveBeenCalledTimes(1);
  });

  it('does nothing to a player that has nothing engaged', () => {
    player.context = { engage: vi.fn(), playback: null };
    const { result } = renderHook(() => usePlayerFollowsReceipt(vi.fn()));

    expect(() =>
      result.current({
        action: 'favoriteTrack',
        track: { id: TRACK_ID, name: 'Night Drive' },
        playlist: FAVORITES,
      }),
    ).not.toThrow();
  });
});
