// @vitest-environment jsdom

// The Lounge visitor view's menu carries the same moves as the playlist's
// Lounge card: Play, Pin, More Like This, and for the Admin the Return to
// Private moderation, which asks first and then leaves for the Lounge.

import { createElement as h } from 'react';
import type { PlaylistMemberItem, PlaylistSummaryItem } from '@liedmotif/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeCreationRefusal, shownCreationRefusal } from '@/components/create/creation-refusal';
import { shownToasts, toast } from '@/lib/toast';
import { PlaylistDetail } from './playlist-detail';

const pinLounge = vi.hoisted(() => vi.fn());
const moderate = vi.hoisted(() => vi.fn());
const moreLikeThis = vi.hoisted(() => vi.fn());
const engagePlaylist = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());

vi.mock('@/lib/http/api-client', () => ({
  deletePlaylist: vi.fn(),
  deleteTrack: vi.fn(),
  getLoungePlaylist: vi.fn(),
  getPlaylist: vi.fn(),
  markPlaylistPlayed: vi.fn(),
  moderateLoungePlaylist: moderate,
  moreLikeThis,
  pinLoungePlaylist: pinLounge,
  renamePlaylist: vi.fn(),
}));
vi.mock('@/components/player/player-provider', () => ({
  usePlayerActions: () => ({
    engage: vi.fn(),
    engagePlaylist,
    beginOtherMusic: () => Promise.resolve(true),
  }),
}));
vi.mock('@/components/sessions/use-seed-more-like-this', () => ({
  useSeedMoreLikeThis: () => moreLikeThis,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

afterEach(() => {
  cleanup();
  pinLounge.mockReset();
  moderate.mockReset();
  moreLikeThis.mockReset();
  engagePlaylist.mockReset();
  push.mockReset();
  closeCreationRefusal();
  toast.dismiss();
});

const PLAYLIST: PlaylistSummaryItem = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Late Drive',
  kind: 'user',
  listedInPlaylists: true,
  trackCount: 1,
  totalDurationSeconds: 180,
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

const MEMBER: PlaylistMemberItem = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Track',
  generatedArtistName: null,
  status: 'ready',
  durationSeconds: 180,
  coverImageId: null,
  audioUrl: '/api/tracks/1/audio',
  savedAt: null,
  favoritedAt: null,
  inCuratedPlaylist: false,
  dislikedAt: null,
  genreTags: [],
  vocalMode: 'instrumental',
  hasLyrics: false,
  downloadable: false,
  position: 0,
  originSessionTitle: null,
  owner: null,
};

function renderVisitor({ isAdmin = false } = {}) {
  render(
    h(PlaylistDetail, {
      playlistId: PLAYLIST.id,
      initial: { playlist: PLAYLIST, items: [MEMBER] },
      visitor: {
        owner: { name: 'Anna Schmidt', artistName: 'Nightowl', imageUrl: null },
        pinned: false,
        isAdmin,
      },
    }),
  );
  fireEvent.click(screen.getByTestId('playlist-menu'));
}

describe('PlaylistDetail — visitor menu', () => {
  it('offers Play, Pin and More Like This, and no moderation for a Member', () => {
    renderVisitor();
    // The menu is the one Pin control on the page.
    expect(screen.getAllByText('Pin in the Lounge')).toHaveLength(1);
    expect(screen.getByTestId(`lounge-menu-play-${PLAYLIST.id}`)).toBeTruthy();
    expect(screen.getByTestId(`lounge-menu-pin-${PLAYLIST.id}`)).toBeTruthy();
    expect(screen.getByTestId(`lounge-menu-more-like-this-${PLAYLIST.id}`)).toBeTruthy();
    expect(screen.queryByTestId(`lounge-menu-return-to-private-${PLAYLIST.id}`)).toBeNull();
  });

  it('plays the playlist in the visitor scope', async () => {
    renderVisitor();
    fireEvent.click(screen.getByTestId(`lounge-menu-play-${PLAYLIST.id}`));
    await waitFor(() => expect(engagePlaylist).toHaveBeenCalledTimes(1));
    expect(engagePlaylist).toHaveBeenCalledWith(PLAYLIST, [MEMBER], null, { foreign: true });
  });

  it('pins it from the menu and shows the new state there', async () => {
    pinLounge.mockResolvedValue({ ok: true, data: { playlistId: PLAYLIST.id, pinned: true } });
    renderVisitor();
    fireEvent.click(screen.getByTestId(`lounge-menu-pin-${PLAYLIST.id}`));
    fireEvent.click(screen.getByTestId('playlist-menu'));
    await waitFor(() => expect(screen.getByText('Unpin Playlist')).toBeTruthy());
    expect(pinLounge).toHaveBeenCalledWith(PLAYLIST.id, true);
  });

  it('starts More Like This from its tracks', async () => {
    moreLikeThis.mockResolvedValue(null);
    renderVisitor();
    fireEvent.click(screen.getByTestId(`lounge-menu-more-like-this-${PLAYLIST.id}`));
    await waitFor(() => expect(moreLikeThis).toHaveBeenCalledWith([MEMBER.id]));
  });

  it('opens the blocked dialog when More Like This has no headroom', async () => {
    const message = 'A new Session needs 5 Tracks; you have 4 left today.';
    moreLikeThis.mockResolvedValue({ code: 'session_headroom_blocked', message });
    renderVisitor();
    fireEvent.click(screen.getByTestId(`lounge-menu-more-like-this-${PLAYLIST.id}`));
    await waitFor(() => expect(shownCreationRefusal()).toEqual({ kind: 'headroom', message }));
    expect(shownToasts()).toEqual([]);
  });

  it('lets the Admin return it to Private after confirming, then goes back to the Lounge', async () => {
    moderate.mockResolvedValue({ ok: true, data: {} });
    renderVisitor({ isAdmin: true });
    fireEvent.click(screen.getByTestId(`lounge-menu-return-to-private-${PLAYLIST.id}`));
    expect(moderate).not.toHaveBeenCalled();
    expect(screen.getByTestId('confirm-dialog').textContent).toContain('Nightowl');
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/lounge'));
    expect(moderate).toHaveBeenCalledWith(PLAYLIST.id);
  });
});
