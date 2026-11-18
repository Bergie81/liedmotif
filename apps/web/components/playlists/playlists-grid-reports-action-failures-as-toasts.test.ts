// @vitest-environment jsdom

// The Playlists grid reports a failed act on a card as a toast, so the cards
// stay where they are; only a list that failed to load says so inline.

import { createElement as h, type ComponentType } from 'react';
import type { PlaylistSummaryItem } from '@liedmotif/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { PlaylistsGrid, type PlaylistsFirstPage } from './playlists-grid';

const api = vi.hoisted(() => ({
  deletePlaylist: vi.fn(),
  getAllPlaylistMembers: vi.fn(),
  listPlaylists: vi.fn(),
  pinLibraryPlaylist: vi.fn(),
  sharePlaylist: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  ...api,
  createPlaylist: vi.fn(),
  getLibrary: vi.fn(() => new Promise(() => undefined)),
  getPlaylistShare: vi.fn(),
  markPlaylistPlayed: vi.fn(),
  renamePlaylist: vi.fn(),
}));
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
  trackCount: 2,
  totalDurationSeconds: 360,
  downloadableTrackCount: 2,
  coverImageId: null,
  mosaicCoverImageIds: [],
  soleMemberTrackCount: 0,
  containsTrack: null,
  sharedAt: null,
  pinnedAt: null,
  createdAt: '2026-07-23T10:00:00.000Z',
  updatedAt: '2026-07-23T10:00:00.000Z',
};
const DRIVE: PlaylistSummaryItem = {
  ...FOCUS,
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Drive',
  sharedAt: '2026-07-24T10:00:00.000Z',
};

function renderGrid(playlists: PlaylistSummaryItem[], nextCursor: string | null = null) {
  const Grid = PlaylistsGrid as ComponentType<{ initialPlaylists: PlaylistsFirstPage }>;
  render(h(Grid, { initialPlaylists: { playlists, nextCursor } }));
}

function cardOrder() {
  return screen.getAllByTestId(/^playlist-card-/).map((card) => card.dataset.testid);
}

function shown() {
  return shownToasts().map(({ tone, message }) => ({ tone, message }));
}

async function deleteFocus() {
  fireEvent.click(screen.getByTestId(`playlist-menu-${FOCUS.id}`));
  fireEvent.click(screen.getByTestId(`playlist-menu-delete-${FOCUS.id}`));
  fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
  await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
}

describe('PlaylistsGrid — action failures as toasts', () => {
  it('reports a failed delete as one error toast that a failed retry replaces', async () => {
    api.deletePlaylist.mockResolvedValueOnce({ ok: false, error: { message: 'Offline.' } });
    api.deletePlaylist.mockResolvedValueOnce({ ok: false, error: { message: 'Not found.' } });
    renderGrid([FOCUS, DRIVE]);

    await deleteFocus();
    await waitFor(() =>
      expect(shown()).toEqual([{ tone: 'error', message: 'Delete failed: Offline.' }]),
    );
    await deleteFocus();

    await waitFor(() =>
      expect(shown()).toEqual([{ tone: 'error', message: 'Delete failed: Not found.' }]),
    );
    expect(cardOrder()).toEqual([`playlist-card-${FOCUS.id}`, `playlist-card-${DRIVE.id}`]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears a failed delete once a retry succeeds', async () => {
    api.deletePlaylist.mockResolvedValueOnce({ ok: false, error: { message: 'Offline.' } });
    api.deletePlaylist.mockResolvedValueOnce({ ok: true, data: null });
    renderGrid([FOCUS, DRIVE]);

    await deleteFocus();
    await waitFor(() => expect(shown()).toHaveLength(1));
    await deleteFocus();

    await waitFor(() => expect(cardOrder()).toEqual([`playlist-card-${DRIVE.id}`]));
    expect(shown()).toEqual([]);
  });

  it('reports a Play whose playlist failed to load as an error toast', async () => {
    api.getAllPlaylistMembers.mockResolvedValue({ ok: false, error: { message: 'Offline.' } });
    renderGrid([FOCUS]);

    fireEvent.click(screen.getByTestId(`playlist-play-${FOCUS.id}`));

    await waitFor(() =>
      expect(shown()).toEqual([{ tone: 'error', message: 'Couldn’t load the playlist: Offline.' }]),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a refused Play up when Add Tracks opens on another playlist', async () => {
    api.getAllPlaylistMembers.mockResolvedValueOnce({ ok: false, error: { message: 'Offline.' } });
    api.getAllPlaylistMembers.mockResolvedValueOnce({ ok: true, data: { items: [] } });
    renderGrid([FOCUS, DRIVE]);
    fireEvent.click(screen.getByTestId(`playlist-play-${FOCUS.id}`));
    await waitFor(() => expect(shown()).toHaveLength(1));

    fireEvent.click(screen.getByTestId(`playlist-menu-${DRIVE.id}`));
    fireEvent.click(screen.getByRole('button', { name: /Add Tracks/ }));
    await waitFor(() => expect(api.getAllPlaylistMembers).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(shown()).toEqual([{ tone: 'error', message: 'Couldn’t load the playlist: Offline.' }]);
  });

  it('reports a failed Remove from Lounge as an error toast', async () => {
    api.sharePlaylist.mockResolvedValue({ ok: false, error: { message: 'Network down.' } });
    renderGrid([DRIVE]);

    fireEvent.click(screen.getByTestId(`playlist-menu-${DRIVE.id}`));
    fireEvent.click(screen.getByTestId(`playlist-menu-remove-from-lounge-${DRIVE.id}`));
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() =>
      expect(shown()).toEqual([
        { tone: 'error', message: 'Removing it from the Lounge failed: Network down.' },
      ]),
    );
    expect(screen.getByTestId(`playlist-in-lounge-${DRIVE.id}`)).toBeTruthy();
  });

  it('reports a failed Load more as an error toast and keeps the loaded cards', async () => {
    api.listPlaylists.mockResolvedValue({ ok: false, error: { message: 'Offline.' } });
    renderGrid([FOCUS], 'next-page');

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() =>
      expect(shown()).toEqual([
        { tone: 'error', message: 'Couldn’t load more playlists: Offline.' },
      ]),
    );
    expect(cardOrder()).toEqual([`playlist-card-${FOCUS.id}`]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('still says inline when the list itself failed to load', async () => {
    api.listPlaylists.mockResolvedValue({ ok: false, error: { message: 'Database down.' } });
    render(h(PlaylistsGrid));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Couldn’t load playlists: Database down.',
    );
    expect(shown()).toEqual([]);
  });
});
