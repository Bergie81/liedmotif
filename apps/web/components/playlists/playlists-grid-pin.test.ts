// @vitest-environment jsdom

// The Library pin toggle: a card's menu pins or unpins it,
// and the card moves to its new place right away.

import { createElement as h, type ComponentType } from 'react';
import type { PlaylistSummaryItem } from '@liedmotif/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { announceOutsideLibraryWrite } from '@/lib/offline/library-writes';
import { shownToasts, toast } from '@/lib/toast';
import { PlaylistsGrid, type PlaylistsFirstPage } from './playlists-grid';

const listPlaylists = vi.hoisted(() => vi.fn());
const pinLibrary = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());

vi.mock('@/lib/http/api-client', () => ({
  createPlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  getAllPlaylistMembers: vi.fn(),
  getPlaylistShare: vi.fn(),
  listPlaylists,
  markPlaylistPlayed: vi.fn(),
  pinLibraryPlaylist: pinLibrary,
  renamePlaylist: vi.fn(),
}));
vi.mock('@/components/player/player-provider', () => ({
  usePlayerActions: () => ({
    engage: vi.fn(),
    engagePlaylist: vi.fn(),
    beginOtherMusic: vi.fn(),
  }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));

afterEach(() => {
  cleanup();
  toast.dismiss();
  listPlaylists.mockReset();
  pinLibrary.mockReset();
  refresh.mockReset();
});

const base: PlaylistSummaryItem = {
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
const OTHER: PlaylistSummaryItem = {
  ...base,
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Drive',
};
const PINNED_AT = '2026-07-23T11:00:00.000Z';

function renderGrid(playlists: PlaylistSummaryItem[]) {
  const Grid = PlaylistsGrid as ComponentType<{ initialPlaylists: PlaylistsFirstPage }>;
  render(h(Grid, { initialPlaylists: { playlists, nextCursor: null } }));
}

function cardOrder() {
  return screen.getAllByTestId(/^playlist-card-/).map((card) => card.dataset.testid);
}

function tapPinRow(playlist: PlaylistSummaryItem) {
  fireEvent.click(screen.getByTestId(`playlist-menu-${playlist.id}`));
  fireEvent.click(screen.getByTestId(`playlist-menu-pin-${playlist.id}`));
}

function searchFor(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/Search playlists/), { target: { value: text } });
}

describe('PlaylistsGrid — a write from outside the page', () => {
  it('reloads the list, keeping the search that is typed', async () => {
    listPlaylists.mockResolvedValue({ ok: true, data: { playlists: [base], nextCursor: null } });
    renderGrid([base]);
    searchFor('foc');
    await waitFor(() => expect(listPlaylists).toHaveBeenCalledTimes(1));

    listPlaylists.mockResolvedValueOnce({
      ok: true,
      data: { playlists: [base, OTHER], nextCursor: null },
    });
    announceOutsideLibraryWrite();

    await waitFor(() =>
      expect(cardOrder()).toEqual([`playlist-card-${base.id}`, `playlist-card-${OTHER.id}`]),
    );
    expect(listPlaylists).toHaveBeenLastCalledWith({ search: 'foc' });
  });
});

describe('PlaylistsGrid — a failed load', () => {
  it('keeps the list and its search field, and clears the banner on the next good load', async () => {
    listPlaylists.mockResolvedValueOnce({ ok: false, error: { message: 'Database down.' } });
    renderGrid([base]);

    searchFor('dri');

    expect(await screen.findByText(/Couldn’t load playlists: Database down/)).toBeTruthy();
    expect(cardOrder()).toEqual([`playlist-card-${base.id}`]);

    listPlaylists.mockResolvedValueOnce({
      ok: true,
      data: { playlists: [OTHER], nextCursor: null },
    });
    searchFor('driv');

    await waitFor(() => expect(cardOrder()).toEqual([`playlist-card-${OTHER.id}`]));
    expect(screen.queryByText(/Couldn’t load playlists/)).toBeNull();
  });

  it('can recover from a first load that failed, with nothing to keep', async () => {
    listPlaylists.mockResolvedValueOnce({ ok: false, error: { message: 'Database down.' } });
    render(h(PlaylistsGrid));

    expect(await screen.findByText(/Couldn’t load playlists: Database down/)).toBeTruthy();
    expect(screen.queryByText('Loading Playlists…')).toBeNull();

    listPlaylists.mockResolvedValueOnce({
      ok: true,
      data: { playlists: [base], nextCursor: null },
    });
    searchFor('foc');

    await waitFor(() => expect(cardOrder()).toEqual([`playlist-card-${base.id}`]));
    expect(screen.queryByText(/Couldn’t load playlists/)).toBeNull();
  });
});

describe('PlaylistsGrid — Library pin', () => {
  it('reloads under the current search when it changed while the pin was saving', async () => {
    let landPin!: (value: unknown) => void;
    pinLibrary.mockReturnValue(new Promise((resolve) => (landPin = resolve)));
    listPlaylists.mockResolvedValue({ ok: true, data: { playlists: [base], nextCursor: null } });
    renderGrid([base]);

    tapPinRow(base);
    searchFor('foc');
    await waitFor(() => expect(listPlaylists).toHaveBeenCalledTimes(1));
    landPin({ ok: true, data: { playlistId: base.id, pinned: true } });

    await waitFor(() => expect(listPlaylists).toHaveBeenCalledTimes(2));
    expect(listPlaylists).toHaveBeenLastCalledWith({ search: 'foc' });
  });

  it('moves the pinned card to the front through a reload of the list', async () => {
    pinLibrary.mockResolvedValue({ ok: true, data: { playlistId: base.id, pinned: true } });
    listPlaylists.mockResolvedValue({
      ok: true,
      data: { playlists: [{ ...base, pinnedAt: PINNED_AT }, OTHER], nextCursor: null },
    });
    renderGrid([OTHER, base]);
    expect(cardOrder()).toEqual([`playlist-card-${OTHER.id}`, `playlist-card-${base.id}`]);

    tapPinRow(base);

    await waitFor(() =>
      expect(cardOrder()).toEqual([`playlist-card-${base.id}`, `playlist-card-${OTHER.id}`]),
    );
    expect(pinLibrary).toHaveBeenCalledWith(base.id, true);
    expect(screen.getByTestId(`playlist-pinned-${base.id}`)).toBeTruthy();
    // Back-navigation replays the router cache's pre-pin seed until it is dropped.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the list and names the failure when the reload after a pin fails', async () => {
    pinLibrary.mockResolvedValue({ ok: true, data: { playlistId: base.id, pinned: true } });
    listPlaylists.mockResolvedValue({ ok: false, error: { message: 'Network down.' } });
    renderGrid([OTHER, base]);

    tapPinRow(base);

    await waitFor(() => expect(screen.getByText(/Couldn’t load playlists/)).toBeTruthy());
    expect(cardOrder()).toEqual([`playlist-card-${OTHER.id}`, `playlist-card-${base.id}`]);
  });

  it('offers Unpin on a pinned card and asks the server to unpin', async () => {
    pinLibrary.mockResolvedValue({ ok: true, data: { playlistId: base.id, pinned: false } });
    listPlaylists.mockResolvedValue({
      ok: true,
      data: { playlists: [OTHER, base], nextCursor: null },
    });
    renderGrid([{ ...base, pinnedAt: PINNED_AT }, OTHER]);

    fireEvent.click(screen.getByTestId(`playlist-menu-${base.id}`));
    const row = screen.getByTestId(`playlist-menu-pin-${base.id}`);
    expect(row.textContent).toContain('Unpin Playlist');
    fireEvent.click(row);

    await waitFor(() =>
      expect(cardOrder()).toEqual([`playlist-card-${OTHER.id}`, `playlist-card-${base.id}`]),
    );
    expect(pinLibrary).toHaveBeenCalledWith(base.id, false);
    expect(screen.queryByTestId(`playlist-pinned-${base.id}`)).toBeNull();
  });

  it('keeps the order and names the failure in an error toast when the pin is refused', async () => {
    pinLibrary.mockResolvedValue({ ok: false, error: { message: 'Playlist not found.' } });
    renderGrid([OTHER, base]);

    tapPinRow(base);

    await waitFor(() =>
      expect(shownToasts()).toEqual([
        expect.objectContaining({
          tone: 'error',
          message: expect.stringMatching(/^Couldn’t pin the playlist/),
        }),
      ]),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(listPlaylists).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(cardOrder()).toEqual([`playlist-card-${OTHER.id}`, `playlist-card-${base.id}`]);
  });
});
