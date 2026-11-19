// @vitest-environment jsdom

// A playlist In the Lounge carries its own way out on its card menu: one row
// that, after a confirm, returns it to Private without the audience picker.

import { createElement as h, type ComponentType } from 'react';
import type { PlaylistSummaryItem } from '@liedmotif/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaylistsGrid, type PlaylistsFirstPage } from './playlists-grid';

const sharePlaylist = vi.hoisted(() => vi.fn());

vi.mock('@/lib/http/api-client', () => ({
  createPlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  getAllPlaylistMembers: vi.fn(),
  getPlaylistShare: vi.fn(),
  listPlaylists: vi.fn(),
  markPlaylistPlayed: vi.fn(),
  pinLibraryPlaylist: vi.fn(),
  renamePlaylist: vi.fn(),
  sharePlaylist,
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

afterEach(() => {
  cleanup();
  sharePlaylist.mockReset();
});

const PRIVATE: PlaylistSummaryItem = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Focus',
  kind: 'user',
  listedInPlaylists: true,
  trackCount: 2,
  totalDurationSeconds: 360,
  downloadableTrackCount: 2,
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
const SHARED: PlaylistSummaryItem = {
  ...PRIVATE,
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Drive',
  sharedAt: '2026-07-24T10:00:00.000Z',
};

function renderGrid(playlists: PlaylistSummaryItem[]) {
  const Grid = PlaylistsGrid as ComponentType<{ initialPlaylists: PlaylistsFirstPage }>;
  render(h(Grid, { initialPlaylists: { playlists, nextCursor: null } }));
}

function openMenu(playlist: PlaylistSummaryItem) {
  fireEvent.click(screen.getByTestId(`playlist-menu-${playlist.id}`));
}

describe('PlaylistsGrid — Remove from Lounge', () => {
  it('is offered only on a playlist that is in the Lounge', () => {
    renderGrid([PRIVATE, SHARED]);
    openMenu(PRIVATE);
    expect(screen.queryByTestId(`playlist-menu-remove-from-lounge-${PRIVATE.id}`)).toBeNull();
    cleanup();

    renderGrid([PRIVATE, SHARED]);
    openMenu(SHARED);
    expect(screen.getByTestId(`playlist-menu-remove-from-lounge-${SHARED.id}`)).toBeTruthy();
  });

  it('returns it to Private after a confirm and drops the In the Lounge mark', async () => {
    sharePlaylist.mockResolvedValue({ ok: true, data: { playlistId: SHARED.id, sharedAt: null } });
    renderGrid([SHARED]);
    openMenu(SHARED);
    fireEvent.click(screen.getByTestId(`playlist-menu-remove-from-lounge-${SHARED.id}`));
    expect(sharePlaylist).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(sharePlaylist).toHaveBeenCalledWith(SHARED.id, null);
    expect(screen.queryByTestId(`playlist-in-lounge-${SHARED.id}`)).toBeNull();
  });

  it('commits nothing when the confirm is cancelled', () => {
    renderGrid([SHARED]);
    openMenu(SHARED);
    fireEvent.click(screen.getByTestId(`playlist-menu-remove-from-lounge-${SHARED.id}`));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(sharePlaylist).not.toHaveBeenCalled();
    expect(screen.getByTestId(`playlist-in-lounge-${SHARED.id}`)).toBeTruthy();
  });
});
