// @vitest-environment jsdom

// Favorites is a card in the Playlists grid like any other: its menu offers
// every act a playlist has, sharing in the Lounge included, except the two the
// app keeps (Rename, Delete) and the pin, since Favorites always leads.

import { createElement as h, type ComponentType } from 'react';
import type { PlaylistSummaryItem } from '@liedmotif/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaylistsGrid, type PlaylistsFirstPage } from './playlists-grid';

vi.mock('@/lib/http/api-client', () => ({
  createPlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  getAllPlaylistMembers: vi.fn(),
  getPlaylistShare: vi.fn(),
  listPlaylists: vi.fn(),
  markPlaylistPlayed: vi.fn(),
  pinLibraryPlaylist: vi.fn(),
  renamePlaylist: vi.fn(),
  sharePlaylist: vi.fn(),
}));
// The cover sheet has its own tests; these never open it.
vi.mock('./playlist-cover-sheet', () => ({ PlaylistCoverSheet: () => null }));
vi.mock('@/components/player/player-provider', () => ({
  usePlayerActions: () => ({
    engage: vi.fn(),
    engagePlaylist: vi.fn(),
    beginOtherMusic: vi.fn(),
  }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

afterEach(cleanup);

const FAVORITES: PlaylistSummaryItem = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Favorites',
  kind: 'favorites',
  listedInPlaylists: false,
  trackCount: 3,
  totalDurationSeconds: 540,
  downloadableTrackCount: 3,
  coverImageId: null,
  mosaicCoverImageIds: [],
  soleMemberTrackCount: 0,
  soleMemberDeletedTrackCount: 0,
  containsTrack: null,
  sharedAt: null,
  pinnedAt: null,
  createdAt: '2026-07-23T10:00:00.000Z',
  updatedAt: '2026-07-23T10:00:00.000Z',
};
const PINNED: PlaylistSummaryItem = {
  ...FAVORITES,
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Drive',
  kind: 'user',
  listedInPlaylists: true,
  pinnedAt: '2026-07-24T10:00:00.000Z',
};

function renderGrid(playlists: PlaylistSummaryItem[]) {
  const Grid = PlaylistsGrid as ComponentType<{ initialPlaylists: PlaylistsFirstPage }>;
  render(h(Grid, { initialPlaylists: { playlists, nextCursor: null } }));
}

function openMenu(playlist: PlaylistSummaryItem) {
  fireEvent.click(screen.getByTestId(`playlist-menu-${playlist.id}`));
}

describe('PlaylistsGrid — the Favorites card', () => {
  it('leads the grid, ahead of a pinned playlist, and opens its own page', () => {
    renderGrid([PINNED, FAVORITES]);
    expect(screen.getAllByTestId(/^playlist-card-/).map((card) => card.dataset.testid)).toEqual([
      `playlist-card-${FAVORITES.id}`,
      `playlist-card-${PINNED.id}`,
    ]);
    expect(screen.getByRole('link', { name: 'Open Favorites' }).getAttribute('href')).toBe(
      `/library/playlist/${FAVORITES.id}`,
    );
  });

  it('offers play, add, cover, share and download, but no rename, delete or pin', () => {
    renderGrid([FAVORITES]);
    openMenu(FAVORITES);

    for (const label of [
      'Play',
      'Add Tracks',
      'Add Playlist Cover Art',
      'Share Playlist in the Lounge',
      'Download Playlist',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.queryByText('Rename Playlist')).toBeNull();
    expect(screen.queryByTestId(`playlist-menu-delete-${FAVORITES.id}`)).toBeNull();
    expect(screen.queryByTestId(`playlist-menu-pin-${FAVORITES.id}`)).toBeNull();
  });

  it('carries the In the Lounge cue and its way out once shared', () => {
    const shared = { ...FAVORITES, sharedAt: '2026-07-25T10:00:00.000Z' };
    renderGrid([shared]);
    expect(screen.getByTestId(`playlist-in-lounge-${FAVORITES.id}`)).toBeTruthy();

    openMenu(shared);
    expect(screen.getByText('Edit Sharing')).toBeTruthy();
    expect(screen.getByTestId(`playlist-menu-remove-from-lounge-${FAVORITES.id}`)).toBeTruthy();
  });
});
