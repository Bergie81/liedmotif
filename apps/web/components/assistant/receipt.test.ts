// A receipt as the chat shows it: worded here, from the values the server
// sent, and from nothing the model wrote.

import type { AssistantReceipt } from '@liedmotif/shared';
import { describe, expect, it } from 'vitest';
import { receiptLine } from './receipt';

const TRACK = { id: '0c9d4b7a-8a41-4b0e-b1a3-5a2d9d6c7e22', name: 'Night Drive' };
const SECOND = { id: '1d0e5c8b-9b52-4c1f-a2b4-6b3e0e7d8f33', name: 'Tempo' };
const PLAYLIST = { id: '7b0a1c5e-3f0d-4a55-9d0e-2f6f3f1f8a11', name: 'Running' };
const FAVORITES = { id: '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f', name: 'Favorites' };
const SESSION = { id: '5d2f8e1b-6c3a-4f7e-8b9d-1a2b3c4d5e6f', name: 'Rainy Window' };

const playlistPage = (id: string) => `/library/playlist/${id}`;

describe('a receipt line', () => {
  it.each<[string, AssistantReceipt, string, { path: string; place: string }]>([
    [
      'a favorited Track',
      { action: 'favoriteTrack', track: TRACK, playlist: FAVORITES },
      'Added to Favorites: Night Drive',
      { path: playlistPage(FAVORITES.id), place: 'Favorites' },
    ],
    [
      'one Track added to a Playlist',
      { action: 'addToPlaylist', playlist: PLAYLIST, retention: 'curated', tracks: [TRACK] },
      'Added to Running: Night Drive',
      { path: playlistPage(PLAYLIST.id), place: 'Running' },
    ],
    [
      'several Tracks added to a Playlist',
      {
        action: 'addToPlaylist',
        playlist: PLAYLIST,
        retention: 'curated',
        tracks: [TRACK, SECOND],
      },
      'Added 2 Tracks to Running',
      { path: playlistPage(PLAYLIST.id), place: 'Running' },
    ],
    [
      'a new Playlist',
      { action: 'createPlaylist', playlist: PLAYLIST },
      'Created Playlist: Running',
      { path: playlistPage(PLAYLIST.id), place: 'Running' },
    ],
    [
      'a renamed Playlist',
      { action: 'renamePlaylist', playlist: PLAYLIST, previousName: 'Jogging' },
      'Renamed Playlist: Jogging → Running',
      { path: playlistPage(PLAYLIST.id), place: 'Running' },
    ],
    [
      'a pinned Playlist',
      { action: 'pinPlaylist', playlist: PLAYLIST },
      'Pinned Playlist: Running',
      { path: '/library', place: 'Library' },
    ],
    [
      'New music switched off',
      { action: 'newMusicOff', session: SESSION },
      'New music off: Rainy Window',
      { path: '/player', place: 'Now Playing' },
    ],
  ])('for %s says what was done and links to where it is', (_what, receipt, text, link) => {
    expect(receiptLine(receipt)).toEqual({ text, link });
  });

  it('names a Track or Session without a title the way the app does', () => {
    expect(
      receiptLine({
        action: 'favoriteTrack',
        track: { ...TRACK, name: null },
        playlist: FAVORITES,
      }).text,
    ).toBe('Added to Favorites: Untitled Track');
    expect(receiptLine({ action: 'newMusicOff', session: { ...SESSION, name: null } }).text).toBe(
      'New music off: Untitled Session',
    );
  });
});
