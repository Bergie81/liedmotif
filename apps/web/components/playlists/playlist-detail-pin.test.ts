// @vitest-environment jsdom

// The visitor view's Pin toggle: the Lounge it leads back to
// lists Pins first, and back-navigation replays the router cache's pre-pin seed
// until the toggle drops it.

import { createElement as h } from 'react';
import type { PlaylistSummaryItem } from '@liedmotif/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaylistDetail } from './playlist-detail';

const pinLounge = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api-client', () => ({
  deletePlaylist: vi.fn(),
  deleteTrack: vi.fn(),
  getLoungePlaylist: vi.fn(),
  getPlaylist: vi.fn(),
  markPlaylistPlayed: vi.fn(),
  moreLikeThis: vi.fn(),
  pinLoungePlaylist: pinLounge,
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
  pinLounge.mockReset();
  refresh.mockReset();
});

const PLAYLIST: PlaylistSummaryItem = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Late Drive',
  kind: 'user',
  listedInPlaylists: true,
  trackCount: 0,
  totalDurationSeconds: 0,
  downloadableTrackCount: 0,
  coverImageId: null,
  mosaicCoverImageIds: [],
  soleMemberTrackCount: 0,
  containsTrack: null,
  sharedAt: '2026-10-27T10:00:00.000Z',
  pinnedAt: null,
  createdAt: '2026-10-27T10:00:00.000Z',
  updatedAt: '2026-10-27T10:00:00.000Z',
};

function renderVisitor() {
  render(
    h(PlaylistDetail, {
      playlistId: PLAYLIST.id,
      initial: { playlist: PLAYLIST, items: [] },
      visitor: { owner: { name: 'Anna', artistName: null, imageUrl: null }, pinned: false },
    }),
  );
}

describe('PlaylistDetail — visitor Pin toggle', () => {
  it('drops the cached Lounge once the pin lands', async () => {
    pinLounge.mockResolvedValue({ ok: true, data: { playlistId: PLAYLIST.id, pinned: true } });
    renderVisitor();

    fireEvent.click(screen.getByTestId('playlist-pin-toggle'));

    await waitFor(() =>
      expect(screen.getByTestId('playlist-pin-toggle').getAttribute('aria-pressed')).toBe('true'),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('leaves the cache alone when the pin is refused', async () => {
    pinLounge.mockResolvedValue({ ok: false, error: { message: 'Playlist not found.' } });
    renderVisitor();

    fireEvent.click(screen.getByTestId('playlist-pin-toggle'));

    await waitFor(() => expect(screen.getByText(/Couldn’t pin the playlist/)).toBeTruthy());
    expect(refresh).not.toHaveBeenCalled();
  });
});
