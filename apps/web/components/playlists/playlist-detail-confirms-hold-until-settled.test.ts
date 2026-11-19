// @vitest-environment jsdom

// A Playlist page's confirm stays open and busy until its write settles, so a
// second tap on the confirm can never send the write twice.

import { createElement as h } from 'react';
import type { PlaylistSummaryItem } from '@liedmotif/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaylistDetail } from './playlist-detail';

const deletePlaylist = vi.hoisted(() => vi.fn());
const moderate = vi.hoisted(() => vi.fn());

vi.mock('@/lib/http/api-client', () => ({
  deletePlaylist,
  deleteTrack: vi.fn(),
  getLoungePlaylist: vi.fn(),
  getPlaylist: vi.fn(),
  markPlaylistPlayed: vi.fn(),
  moderateLoungePlaylist: moderate,
  moreLikeThis: vi.fn(),
  pinLoungePlaylist: vi.fn(),
  renamePlaylist: vi.fn(),
}));
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
  deletePlaylist.mockReset();
  moderate.mockReset();
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
  soleMemberDeletedTrackCount: 0,
  containsTrack: null,
  sharedAt: '2026-10-27T10:00:00.000Z',
  pinnedAt: null,
  createdAt: '2026-10-27T10:00:00.000Z',
  updatedAt: '2026-10-27T10:00:00.000Z',
};

async function confirmTwice() {
  const confirm = screen.getByTestId('confirm-dialog-confirm');
  fireEvent.click(confirm);
  // Let every settled microtask land before the second tap.
  await act(async () => {});
  fireEvent.click(confirm);
  return confirm;
}

describe('PlaylistDetail — confirms hold until the write settles', () => {
  it('deletes once and stays busy while the delete is in flight', async () => {
    deletePlaylist.mockReturnValue(new Promise(() => {}));
    render(
      h(PlaylistDetail, { playlistId: PLAYLIST.id, initial: { playlist: PLAYLIST, items: [] } }),
    );
    fireEvent.click(screen.getByTestId('playlist-menu'));
    fireEvent.click(screen.getByTestId('playlist-menu-delete'));

    const confirm = await confirmTwice();

    expect(confirm.hasAttribute('disabled')).toBe(true);
    expect(deletePlaylist).toHaveBeenCalledTimes(1);
  });

  it('returns it to Private once and stays busy while the moderation is in flight', async () => {
    moderate.mockReturnValue(new Promise(() => {}));
    render(
      h(PlaylistDetail, {
        playlistId: PLAYLIST.id,
        initial: { playlist: PLAYLIST, items: [] },
        visitor: {
          owner: { name: 'Anna Schmidt', artistName: 'Nightowl', imageUrl: null },
          isAdmin: true,
        },
      }),
    );
    fireEvent.click(screen.getByTestId('playlist-menu'));
    fireEvent.click(screen.getByTestId(`lounge-menu-return-to-private-${PLAYLIST.id}`));

    const confirm = await confirmTwice();

    expect(confirm.hasAttribute('disabled')).toBe(true);
    expect(moderate).toHaveBeenCalledTimes(1);
  });
});
