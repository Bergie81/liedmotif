// @vitest-environment jsdom

// The Playlist page reports what its acts did as toasts, so nothing in the page
// moves; only a Playlist that failed to load says so inline.

import { createElement as h } from 'react';
import type { PlaylistMemberItem, PlaylistSummaryItem } from '@liedmotif/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { PlaylistDetail } from './playlist-detail';

const api = vi.hoisted(() => ({
  deleteTrack: vi.fn(),
  getPlaylist: vi.fn(),
  removePlaylistTrack: vi.fn(),
}));

vi.mock('@/lib/http/api-client', () => ({
  ...api,
  deletePlaylist: vi.fn(),
  getAllPlaylistMembers: vi.fn(),
  getLoungePlaylist: vi.fn(),
  markPlaylistPlayed: vi.fn(),
  moreLikeThis: vi.fn(),
  pinLoungePlaylist: vi.fn(),
  renamePlaylist: vi.fn(),
}));
vi.mock('@/components/player/player-provider', () => ({
  usePlayerActions: () => ({ engage: vi.fn(), engagePlaylist: vi.fn(), beginOtherMusic: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  toast.dismiss();
  for (const mock of Object.values(api)) mock.mockReset();
});

const PLAYLIST: PlaylistSummaryItem = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Late Drive',
  kind: 'user',
  listedInPlaylists: true,
  trackCount: 1,
  totalDurationSeconds: 180,
  downloadableTrackCount: 1,
  coverImageId: null,
  mosaicCoverImageIds: [],
  soleMemberTrackCount: 0,
  soleMemberDeletedTrackCount: 0,
  containsTrack: null,
  sharedAt: null,
  pinnedAt: null,
  createdAt: '2026-10-27T10:00:00.000Z',
  updatedAt: '2026-10-27T10:00:00.000Z',
};

const ITEM = {
  id: 'track-1',
  position: 0,
  title: 'Nachtfahrt',
  durationSeconds: 180,
  coverImageId: null,
  audioUrl: '/api/tracks/track-1/audio',
  savedAt: '2026-07-20T10:00:00.000Z',
  favoritedAt: null,
  addedAt: '2026-07-21T10:00:00.000Z',
  genreTags: [],
  downloadable: true,
  owner: null,
} as unknown as PlaylistMemberItem;

function renderPage() {
  render(
    h(PlaylistDetail, { playlistId: PLAYLIST.id, initial: { playlist: PLAYLIST, items: [ITEM] } }),
  );
}

function openTrackOptions() {
  fireEvent.click(screen.getByRole('button', { name: 'Options for Nachtfahrt' }));
}

async function deleteTrackEverywhere() {
  openTrackOptions();
  fireEvent.click(screen.getByTestId('playlist-delete-track'));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
}

function shown() {
  return shownToasts().map(({ tone, message }) => ({ tone, message }));
}

describe('PlaylistDetail — results as toasts', () => {
  it('reports a deleted Track as a success toast', async () => {
    api.deleteTrack.mockResolvedValue({ ok: true, data: null });
    renderPage();

    await deleteTrackEverywhere();

    await waitFor(() =>
      expect(shown()).toEqual([
        {
          tone: 'success',
          message: 'Track deleted — its audio is removed and it left every Playlist.',
        },
      ]),
    );
    expect(screen.queryByTestId('playlist-member')).toBeNull();
  });

  it('reports a failed delete as one error toast that a failed retry replaces', async () => {
    api.deleteTrack.mockResolvedValueOnce({ ok: false, error: { message: 'Offline.' } });
    api.deleteTrack.mockResolvedValueOnce({ ok: false, error: { message: 'Not found.' } });
    renderPage();

    await deleteTrackEverywhere();
    await waitFor(() =>
      expect(shown()).toEqual([{ tone: 'error', message: 'Delete failed: Offline.' }]),
    );
    await deleteTrackEverywhere();

    await waitFor(() =>
      expect(shown()).toEqual([{ tone: 'error', message: 'Delete failed: Not found.' }]),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears a failed delete once a retry succeeds', async () => {
    api.deleteTrack.mockResolvedValueOnce({ ok: false, error: { message: 'Offline.' } });
    api.deleteTrack.mockResolvedValueOnce({ ok: true, data: null });
    renderPage();

    await deleteTrackEverywhere();
    await waitFor(() => expect(shown()).toHaveLength(1));
    await deleteTrackEverywhere();

    await waitFor(() => expect(shown().map((toast) => toast.tone)).toEqual(['success']));
  });

  it('says so in an info toast when a removal took the Track out of the Library', async () => {
    api.removePlaylistTrack.mockResolvedValue({
      ok: true,
      data: { unsaved: true, deletedForGood: false },
    });
    renderPage();

    openTrackOptions();
    fireEvent.click(screen.getByTestId('playlist-remove-track'));

    await waitFor(() =>
      expect(shown()).toEqual([
        {
          tone: 'info',
          message:
            'Removed — that was its last playlist, so the track left your Library (it stays in History).',
        },
      ]),
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  async function removeTrack() {
    await waitFor(() => expect(screen.getByTestId('playlist-member')).toBeTruthy());
    openTrackOptions();
    fireEvent.click(screen.getByTestId('playlist-remove-track'));
  }

  it('replaces a failed removal with a different refusal of the retry', async () => {
    api.removePlaylistTrack.mockResolvedValueOnce({ ok: false, error: { message: 'Offline.' } });
    api.removePlaylistTrack.mockResolvedValueOnce({ ok: false, error: { message: 'Not found.' } });
    renderPage();

    await removeTrack();
    await waitFor(() =>
      expect(shown()).toEqual([{ tone: 'error', message: 'Remove failed: Offline.' }]),
    );
    await removeTrack();

    await waitFor(() =>
      expect(shown()).toEqual([{ tone: 'error', message: 'Remove failed: Not found.' }]),
    );
  });

  it('clears a failed removal when it is tried again', async () => {
    api.removePlaylistTrack.mockResolvedValueOnce({ ok: false, error: { message: 'Offline.' } });
    api.removePlaylistTrack.mockReturnValueOnce(new Promise(() => undefined));
    renderPage();

    await removeTrack();
    await waitFor(() => expect(shown()).toHaveLength(1));
    await removeTrack();

    expect(shown()).toEqual([]);
  });

  it('keeps a failed load inline', async () => {
    api.getPlaylist.mockResolvedValue({ ok: false, error: { message: 'Playlist not found.' } });
    render(h(PlaylistDetail, { playlistId: PLAYLIST.id }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('not found'));
    expect(shownToasts()).toEqual([]);
  });
});
