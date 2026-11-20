// @vitest-environment jsdom

// Add Tracks opens the moment it is picked from a card's options: the
// playlist's members load inside the open sheet, so the menu hands straight
// over to it with no gap where neither sheet is up.

import { createElement as h, type ComponentType } from 'react';
import type { PlaylistSummaryItem } from '@liedmotif/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { PlaylistsGrid, type PlaylistsFirstPage } from './playlists-grid';

const api = vi.hoisted(() => ({
  getAllPlaylistMembers: vi.fn(),
  getLibrary: vi.fn(),
}));

vi.mock('@/lib/http/api-client', () => ({
  ...api,
  createPlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  getPlaylistShare: vi.fn(),
  listPlaylists: vi.fn(),
  markPlaylistPlayed: vi.fn(),
  pinLibraryPlaylist: vi.fn(),
  renamePlaylist: vi.fn(),
  sharePlaylist: vi.fn(),
}));
vi.mock('./playlist-cover-sheet', () => ({ PlaylistCoverSheet: () => null }));
vi.mock('@/components/player/player-provider', () => ({
  usePlayerActions: () => ({ engage: vi.fn(), engagePlaylist: vi.fn(), beginOtherMusic: vi.fn() }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

afterEach(() => {
  cleanup();
  toast.dismiss();
  for (const mock of Object.values(api)) mock.mockReset();
});

const FOCUS: PlaylistSummaryItem = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Focus',
  kind: 'user',
  listedInPlaylists: true,
  trackCount: 1,
  totalDurationSeconds: 120,
  downloadableTrackCount: 1,
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

const TRACK = { id: 't-rain', title: 'Rain on Glass', coverImageId: null, durationSeconds: 120 };

function openAddTracks() {
  const Grid = PlaylistsGrid as ComponentType<{ initialPlaylists: PlaylistsFirstPage }>;
  render(h(Grid, { initialPlaylists: { playlists: [FOCUS], nextCursor: null } }));
  fireEvent.click(screen.getByTestId(`playlist-menu-${FOCUS.id}`));
  fireEvent.click(screen.getByRole('button', { name: /Add Tracks/ }));
}

describe('PlaylistsGrid — Add Tracks opens at once', () => {
  it('opens the sheet before the members arrive, then locks the ones already in', async () => {
    let releaseMembers!: () => void;
    api.getAllPlaylistMembers.mockReturnValue(
      new Promise((resolve) => {
        releaseMembers = () => resolve({ ok: true, data: { items: [{ id: TRACK.id }] } });
      }),
    );
    api.getLibrary.mockResolvedValue({ ok: true, data: { items: [TRACK], nextCursor: null } });

    openAddTracks();

    expect(screen.getByTestId('add-tracks-sheet')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();

    releaseMembers();
    const row = await screen.findByRole('checkbox', { name: /Rain on Glass/ });
    expect(row.getAttribute('aria-checked')).toBe('true');
    expect((row as HTMLButtonElement).disabled).toBe(true);
  });

  it('closes the sheet with an error toast when the members fail to load', async () => {
    api.getAllPlaylistMembers.mockResolvedValue({ ok: false, error: { message: 'Offline.' } });
    api.getLibrary.mockResolvedValue({ ok: true, data: { items: [TRACK], nextCursor: null } });

    openAddTracks();

    await waitFor(() => expect(screen.queryByTestId('add-tracks-sheet')).toBeNull());
    expect(shownToasts().map(({ message }) => message)).toEqual([
      'Couldn’t load the playlist: Offline.',
    ]);
  });

  it('ignores a load from an earlier opening of the same sheet', async () => {
    let failFirst!: () => void;
    let releaseSecond!: () => void;
    api.getAllPlaylistMembers
      .mockReturnValueOnce(
        new Promise((resolve) => {
          failFirst = () => resolve({ ok: false, error: { message: 'Offline.' } });
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          releaseSecond = () => resolve({ ok: true, data: { items: [{ id: TRACK.id }] } });
        }),
      );
    api.getLibrary.mockResolvedValue({ ok: true, data: { items: [TRACK], nextCursor: null } });

    openAddTracks();
    fireEvent.click(screen.getByRole('button', { name: 'Close Add Tracks' }));
    await waitFor(() => expect(screen.queryByTestId('add-tracks-sheet')).toBeNull());
    fireEvent.click(screen.getByTestId(`playlist-menu-${FOCUS.id}`));
    fireEvent.click(screen.getByRole('button', { name: /Add Tracks/ }));

    failFirst();
    releaseSecond();
    const row = await screen.findByRole('checkbox', { name: /Rain on Glass/ });
    expect(row.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('add-tracks-sheet')).toBeTruthy();
    expect(shownToasts()).toEqual([]);
  });
});
