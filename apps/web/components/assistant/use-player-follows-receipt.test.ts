// @vitest-environment jsdom

// The player after the Assistant changed something it shows: the star and the
// Add to Playlist control of the Track on the deck, the title of a Track it
// holds, the name and New Music setting of the engaged Session, and the
// playback settings the player blends with.

import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePlayerFollowsReceipt } from './use-player-follows-receipt';

const TRACK_ID = '0c9d4b7a-8a41-4b0e-b1a3-5a2d9d6c7e22';
const SESSION_ID = '5d2f8e1b-6c3a-4f7e-8b9d-1a2b3c4d5e6f';
const OTHER_ID = '1d0e5c8b-9b52-4c1f-a2b4-6b3e0e7d8f33';
const FAVORITES = { id: '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f', name: 'Favorites' };

const player = vi.hoisted(() => ({
  context: null as unknown,
}));
vi.mock('@/components/player/player-provider', async (importActual) => ({
  ...(await importActual<typeof import('@/components/player/player-provider')>()),
  usePlayerContext: () => player.context,
}));

/** A Session playing `TRACK_ID`, saved long ago and in a hand-picked Playlist, unless `track` says otherwise. */
function playing(track: Record<string, unknown> = {}) {
  const applyRetentionAdded = vi.fn();
  const applyTrackTitle = vi.fn();
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
          ...track,
        },
        applyRetentionAdded,
        applyTrackTitle,
      },
    },
  };
  return { applyRetentionAdded, applyTrackTitle, engage, session };
}

describe('the player, after a receipt', () => {
  it('lights the star of the Track on the deck when that Track was favorited', () => {
    const { applyRetentionAdded } = playing();
    const { result } = renderHook(() => usePlayerFollowsReceipt(vi.fn()));

    result.current({
      action: 'favoriteTrack',
      track: { id: TRACK_ID, name: 'Night Drive' },
      playlist: FAVORITES,
    });

    expect(applyRetentionAdded).toHaveBeenCalledWith(TRACK_ID, {
      favorited: true,
      curated: false,
    });
  });

  it('leaves the deck alone when another Track was favorited', () => {
    const { applyRetentionAdded } = playing();
    const { result } = renderHook(() => usePlayerFollowsReceipt(vi.fn()));

    result.current({
      action: 'favoriteTrack',
      track: { id: OTHER_ID, name: 'Tempo' },
      playlist: FAVORITES,
    });

    expect(applyRetentionAdded).not.toHaveBeenCalled();
  });

  it.each([
    { retention: 'curated' as const, added: { favorited: false, curated: true } },
    { retention: 'favorite' as const, added: { favorited: true, curated: false } },
    { retention: 'saved' as const, added: { favorited: false, curated: false } },
  ])(
    'shows the Track on the deck as kept once it was added to a Playlist ($retention)',
    ({ retention, added }) => {
      const { applyRetentionAdded } = playing({ savedAt: null, inCuratedPlaylist: false });
      const { result } = renderHook(() => usePlayerFollowsReceipt(vi.fn()));

      result.current({
        action: 'addToPlaylist',
        playlist: { id: OTHER_ID, name: 'Running' },
        retention,
        tracks: [{ id: TRACK_ID, name: 'Night Drive' }],
      });

      expect(applyRetentionAdded).toHaveBeenCalledWith(TRACK_ID, added);
    },
  );

  it('leaves the deck alone when the Tracks added to a Playlist were others', () => {
    const { applyRetentionAdded } = playing();
    const { result } = renderHook(() => usePlayerFollowsReceipt(vi.fn()));

    result.current({
      action: 'addToPlaylist',
      playlist: { id: OTHER_ID, name: 'Running' },
      retention: 'curated',
      tracks: [{ id: OTHER_ID, name: 'Tempo' }],
    });

    expect(applyRetentionAdded).not.toHaveBeenCalled();
  });

  it('shows New Music off on the engaged Session without restarting it, and re-reads the shell', () => {
    const { engage, session } = playing();
    const refreshChrome = vi.fn();
    const { result } = renderHook(() => usePlayerFollowsReceipt(refreshChrome));

    result.current({ action: 'newMusicOff', session: { id: SESSION_ID, name: 'Rainy Window' } });

    expect(engage).toHaveBeenCalledWith({ ...session, sessionMode: 'repeat' }, { autoplay: false });
    expect(refreshChrome).toHaveBeenCalledTimes(1);
  });

  it('leaves the engaged Session alone when New Music went off for another one', () => {
    const { engage } = playing();
    const refreshChrome = vi.fn();
    const { result } = renderHook(() => usePlayerFollowsReceipt(refreshChrome));

    result.current({ action: 'newMusicOff', session: { id: OTHER_ID, name: 'Elsewhere' } });

    expect(engage).not.toHaveBeenCalled();
    expect(refreshChrome).toHaveBeenCalledTimes(1);
  });

  it('shows the new name of the engaged Session without restarting it, and re-reads the shell', () => {
    const { engage, session } = playing();
    const refreshChrome = vi.fn();
    const { result } = renderHook(() => usePlayerFollowsReceipt(refreshChrome));

    result.current({
      action: 'renameSession',
      session: { id: SESSION_ID, name: 'Sunday Coffee' },
      previousName: 'Rainy Window',
    });

    expect(engage).toHaveBeenCalledWith(
      { ...session, title: 'Sunday Coffee' },
      { autoplay: false },
    );
    expect(refreshChrome).toHaveBeenCalledTimes(1);
  });

  it('keeps both changes when a rename and New Music off arrive together, before the player re-renders', () => {
    const { engage, session } = playing();
    const { result } = renderHook(() => usePlayerFollowsReceipt(vi.fn()));

    result.current({
      action: 'renameSession',
      session: { id: SESSION_ID, name: 'Sunday Coffee' },
      previousName: 'Rainy Window',
    });
    result.current({ action: 'newMusicOff', session: { id: SESSION_ID, name: 'Sunday Coffee' } });

    expect(engage).toHaveBeenLastCalledWith(
      { ...session, title: 'Sunday Coffee', sessionMode: 'repeat' },
      { autoplay: false },
    );
  });

  it('leaves the engaged Session alone when another one was renamed, and re-reads the shell', () => {
    const { engage } = playing();
    const refreshChrome = vi.fn();
    const { result } = renderHook(() => usePlayerFollowsReceipt(refreshChrome));

    result.current({
      action: 'renameSession',
      session: { id: OTHER_ID, name: 'Sunday Coffee' },
      previousName: 'Elsewhere',
    });

    expect(engage).not.toHaveBeenCalled();
    expect(refreshChrome).toHaveBeenCalledTimes(1);
  });

  it('shows a renamed Track under its new title wherever the player holds it', () => {
    const { applyTrackTitle } = playing();
    const { result } = renderHook(() => usePlayerFollowsReceipt(vi.fn()));

    result.current({
      action: 'renameTrack',
      track: { id: TRACK_ID, name: 'Harbor Lights' },
      previousName: 'Night Drive',
    });

    expect(applyTrackTitle).toHaveBeenCalledWith(TRACK_ID, 'Harbor Lights');
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
    expect(() =>
      result.current({
        action: 'renameTrack',
        track: { id: TRACK_ID, name: 'Harbor Lights' },
        previousName: 'Night Drive',
      }),
    ).not.toThrow();
  });

  it.each([
    ['blend', 'Off', 'On'],
    ['crossfadeSeconds', '9 s', '6 s'],
  ] as const)(
    're-reads its playback settings when %s was changed, writing nothing itself',
    (setting, value, previous) => {
      playing();
      const adoptStoredPlaybackSettings = vi.fn();
      const toggleBlend = vi.fn();
      Object.assign((player.context as { playback: { player: object } }).playback.player, {
        adoptStoredPlaybackSettings,
        toggleBlend,
      });
      const { result } = renderHook(() => usePlayerFollowsReceipt(vi.fn()));

      result.current({ action: 'changeSetting', setting, value, previous });

      expect(adoptStoredPlaybackSettings).toHaveBeenCalledTimes(1);
      expect(toggleBlend).not.toHaveBeenCalled();
    },
  );

  it('re-reads the playback settings of a source arming behind the music, too', () => {
    playing();
    const playingAdopts = vi.fn();
    const pendingAdopts = vi.fn();
    const context = player.context as {
      playback: { player: object };
      pending?: unknown;
    };
    Object.assign(context.playback.player, { adoptStoredPlaybackSettings: playingAdopts });
    context.pending = { source: {}, player: { adoptStoredPlaybackSettings: pendingAdopts } };
    const { result } = renderHook(() => usePlayerFollowsReceipt(vi.fn()));

    result.current({
      action: 'changeSetting',
      setting: 'crossfadeSeconds',
      value: '9 s',
      previous: '6 s',
    });

    expect(playingAdopts).toHaveBeenCalledTimes(1);
    expect(pendingAdopts).toHaveBeenCalledTimes(1);
  });

  it('leaves its playback settings alone when a setting it does not play with changed', () => {
    playing();
    const adoptStoredPlaybackSettings = vi.fn();
    Object.assign((player.context as { playback: { player: object } }).playback.player, {
      adoptStoredPlaybackSettings,
    });
    const { result } = renderHook(() => usePlayerFollowsReceipt(vi.fn()));

    result.current({
      action: 'changeSetting',
      setting: 'defaultLanguage',
      value: 'German',
      previous: 'Auto Detect',
    });

    expect(adoptStoredPlaybackSettings).not.toHaveBeenCalled();
  });
});
