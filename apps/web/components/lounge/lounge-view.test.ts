// @vitest-environment jsdom

// The Admin's Return to Private moderation revokes another owner's
// share and hard-purges every Member's Pins and Shared references with it — a
// re-share never brings them back. So the menu row never moderates on its own
// tap: a confirm dialog naming the owner owns the commit, and closing it
// commits nothing.

import { createElement as h } from 'react';
import type { LoungePlaylistItem } from '@liedmotif/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { closeCreationRefusal, shownCreationRefusal } from '@/components/create/creation-refusal';
import { LoungeView } from './lounge-view';

const moderate = vi.hoisted(() => vi.fn());
const listLounge = vi.hoisted(() => vi.fn());
const pinLounge = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
const getAllMembers = vi.hoisted(() => vi.fn());
const getLounge = vi.hoisted(() => vi.fn());
const engagePlaylist = vi.hoisted(() => vi.fn());
const sharePlaylist = vi.hoisted(() => vi.fn());
const seedMoreLikeThis = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api-client', () => ({
  getAllPlaylistMembers: getAllMembers,
  getLoungePlaylist: getLounge,
  listLoungePlaylists: listLounge,
  pinLoungePlaylist: pinLounge,
  markPlaylistPlayed: vi.fn(),
  moreLikeThis: seedMoreLikeThis,
  moderateLoungePlaylist: moderate,
  sharePlaylist,
}));
vi.mock('@/components/player/player-provider', () => ({
  usePlayerActions: () => ({
    engage: vi.fn(),
    engagePlaylist,
    beginOtherMusic: () => Promise.resolve(true),
  }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
// The share sheet's own picker is covered by its tests; here it stands in as
// the seam that reports a landed share write back to the Lounge.
vi.mock('@/components/playlists/share-playlist-sheet', () => ({
  SharePlaylistSheet: ({
    playlist,
    onShared,
  }: {
    playlist: { id: string } | null;
    onShared: (result: { playlistId: string; sharedAt: string | null }) => void;
  }) =>
    playlist
      ? h(
          'button',
          {
            'data-testid': 'share-sheet-make-private',
            onClick: () => onShared({ playlistId: playlist.id, sharedAt: null }),
          },
          'Make Private',
        )
      : null,
}));

afterEach(() => {
  cleanup();
  toast.dismiss();
  moderate.mockReset();
  listLounge.mockReset();
  pinLounge.mockReset();
  refresh.mockReset();
  getAllMembers.mockReset();
  getLounge.mockReset();
  engagePlaylist.mockReset();
  sharePlaylist.mockReset();
  seedMoreLikeThis.mockReset();
  closeCreationRefusal();
});

const FOREIGN: LoungePlaylistItem = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Late Drive',
  trackCount: 4,
  totalDurationSeconds: 720,
  coverImageId: null,
  mosaicCoverImageIds: [],
  sharedAt: '2026-10-27T10:00:00.000Z',
  yours: false,
  pinned: false,
  ownerName: 'Anna Schmidt',
  ownerArtistName: 'Nightowl',
  ownerImageUrl: null,
  matchContext: null,
};

function renderAsAdmin() {
  render(
    h(LoungeView, {
      initial: { playlists: [FOREIGN], nextCursor: null },
      sharers: [],
      viewerUserId: 'u-admin',
      viewerIsAdmin: true,
    }),
  );
}

function tapReturnToPrivate() {
  fireEvent.click(screen.getByTestId(`lounge-menu-${FOREIGN.id}`));
  fireEvent.click(screen.getByTestId(`lounge-menu-return-to-private-${FOREIGN.id}`));
}

describe('LoungeView — Admin Return to Private', () => {
  it('asks first, naming the owner and the Pins and Shared references that go away', () => {
    renderAsAdmin();
    tapReturnToPrivate();
    expect(moderate).not.toHaveBeenCalled();
    const dialog = screen.getByTestId('confirm-dialog');
    expect(dialog.textContent).toContain('Nightowl');
    expect(dialog.textContent).toContain('Every Pin of it');
    expect(dialog.textContent).toContain('Shared references');
  });

  it('commits nothing when the dialog is cancelled', () => {
    renderAsAdmin();
    tapReturnToPrivate();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(moderate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    expect(screen.getByTestId(`lounge-tile-${FOREIGN.id}`)).toBeTruthy();
  });

  it('moderates once on confirm and drops the tile', async () => {
    moderate.mockResolvedValue({ ok: true, data: {} });
    renderAsAdmin();
    tapReturnToPrivate();
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(moderate).toHaveBeenCalledTimes(1);
    expect(moderate).toHaveBeenCalledWith(FOREIGN.id);
    expect(screen.queryByTestId(`lounge-tile-${FOREIGN.id}`)).toBeNull();
    // The server-rendered sharer cards re-load with the share gone.
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

// A Pin is offered on every tile, your own included, and
// moves the tile to its new place right away.

describe('LoungeView — Pin toggle', () => {
  const OWN: LoungePlaylistItem = {
    ...FOREIGN,
    id: '22222222-2222-4222-8222-222222222222',
    name: 'My Mix',
    yours: true,
  };

  function tileOrder() {
    return screen.getAllByTestId(/^lounge-tile-/).map((tile) => tile.dataset.testid);
  }

  it('offers the pin button on your own tile too', () => {
    render(
      h(LoungeView, {
        initial: { playlists: [FOREIGN, OWN], nextCursor: null },
        sharers: [],
        viewerUserId: 'u-viewer',
        viewerIsAdmin: false,
      }),
    );

    expect(screen.getByTestId(`lounge-pin-${OWN.id}`).getAttribute('aria-label')).toBe(
      'Pin My Mix in the Lounge',
    );
    expect(screen.getByTestId(`lounge-pin-${FOREIGN.id}`)).toBeTruthy();
  });

  it('moves the pinned tile to the front through a reload of the list', async () => {
    pinLounge.mockResolvedValue({ ok: true, data: { playlistId: OWN.id, pinned: true } });
    listLounge.mockResolvedValue({
      ok: true,
      data: { playlists: [{ ...OWN, pinned: true }, FOREIGN], nextCursor: null },
    });
    render(
      h(LoungeView, {
        initial: { playlists: [FOREIGN, OWN], nextCursor: null },
        sharers: [],
        viewerUserId: 'u-viewer',
        viewerIsAdmin: false,
      }),
    );
    expect(tileOrder()).toEqual([`lounge-tile-${FOREIGN.id}`, `lounge-tile-${OWN.id}`]);

    fireEvent.click(screen.getByTestId(`lounge-pin-${OWN.id}`));

    await waitFor(() =>
      expect(tileOrder()).toEqual([`lounge-tile-${OWN.id}`, `lounge-tile-${FOREIGN.id}`]),
    );
    expect(pinLounge).toHaveBeenCalledWith(OWN.id, true);
    expect(screen.getByTestId(`lounge-pin-${OWN.id}`).getAttribute('aria-pressed')).toBe('true');
    // Back-navigation replays the router cache's pre-pin seed until it is dropped.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the list and names the failure when the reload after a pin fails', async () => {
    pinLounge.mockResolvedValue({ ok: true, data: { playlistId: OWN.id, pinned: true } });
    listLounge.mockResolvedValue({ ok: false, error: { message: 'Network down.' } });
    render(
      h(LoungeView, {
        initial: { playlists: [FOREIGN, OWN], nextCursor: null },
        sharers: [],
        viewerUserId: 'u-viewer',
        viewerIsAdmin: false,
      }),
    );

    fireEvent.click(screen.getByTestId(`lounge-pin-${OWN.id}`));

    await waitFor(() => expect(screen.getByText(/Couldn’t load the Lounge/)).toBeTruthy());
    expect(tileOrder()).toEqual([`lounge-tile-${FOREIGN.id}`, `lounge-tile-${OWN.id}`]);
    // The tile shows only what the server's list said: its order and flag move together.
    expect(screen.getByTestId(`lounge-pin-${OWN.id}`).getAttribute('aria-pressed')).toBe('false');
  });

  it('reloads under the current search when it changed while the pin was saving', async () => {
    let landPin!: (value: unknown) => void;
    pinLounge.mockReturnValue(new Promise((resolve) => (landPin = resolve)));
    listLounge.mockResolvedValue({ ok: true, data: { playlists: [FOREIGN], nextCursor: null } });
    render(
      h(LoungeView, {
        initial: { playlists: [FOREIGN], nextCursor: null },
        sharers: [],
        viewerUserId: 'u-viewer',
        viewerIsAdmin: false,
      }),
    );

    fireEvent.click(screen.getByTestId(`lounge-pin-${FOREIGN.id}`));
    fireEvent.change(screen.getByPlaceholderText(/Search shared playlists/), {
      target: { value: 'late' },
    });
    await waitFor(() => expect(listLounge).toHaveBeenCalledTimes(1));
    landPin({ ok: true, data: { playlistId: FOREIGN.id, pinned: true } });

    await waitFor(() => expect(listLounge).toHaveBeenCalledTimes(2));
    expect(listLounge).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'late' }));
  });

  it('keeps the order and names the failure in an error toast when the pin is refused', async () => {
    pinLounge.mockResolvedValue({ ok: false, error: { message: 'Playlist not found.' } });
    render(
      h(LoungeView, {
        initial: { playlists: [FOREIGN, OWN], nextCursor: null },
        sharers: [],
        viewerUserId: 'u-viewer',
        viewerIsAdmin: false,
      }),
    );

    fireEvent.click(screen.getByTestId(`lounge-pin-${OWN.id}`));

    await waitFor(() =>
      expect(shownToasts()).toEqual([
        expect.objectContaining({
          tone: 'error',
          message: expect.stringMatching(/^Couldn’t pin the playlist/),
        }),
      ]),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(listLounge).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(tileOrder()).toEqual([`lounge-tile-${FOREIGN.id}`, `lounge-tile-${OWN.id}`]);
  });
});

// The sharer profile cards are the member filter: a tap narrows the grid to
// that member, a second tap on the lit card lifts the narrowing again.

describe('LoungeView — sharer cards', () => {
  const ANNA = {
    userId: 'u-anna',
    name: 'Anna Schmidt',
    artistName: 'Nightowl',
    imageUrl: null,
    description: 'Rainy windows, late trains',
    sharedTrackCount: 4,
  };

  function viewWith(sharers: (typeof ANNA)[]) {
    return h(LoungeView, {
      initial: { playlists: [FOREIGN], nextCursor: null },
      sharers,
      viewerUserId: 'u-viewer',
      viewerIsAdmin: false,
    });
  }

  function renderWithSharer() {
    listLounge.mockResolvedValue({ ok: true, data: { playlists: [FOREIGN], nextCursor: null } });
    return render(viewWith([ANNA]));
  }

  it('names each card by the sharer alone, described by tracks shared and description', () => {
    renderWithSharer();
    const card = screen.getByRole('button', { name: 'Nightowl' });
    const description = (card.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
      .join(' ');
    expect(description).toBe('4 Tracks shared Rainy windows, late trains');
  });

  it('toggles the member filter from the card', async () => {
    renderWithSharer();
    const card = screen.getByRole('button', { name: 'Nightowl' });
    fireEvent.click(card);
    expect(card.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() =>
      expect(listLounge).toHaveBeenLastCalledWith({ query: undefined, owner: 'u-anna' }),
    );
    fireEvent.click(card);
    expect(card.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() =>
      expect(listLounge).toHaveBeenLastCalledWith({ query: undefined, owner: null }),
    );
  });

  it('falls back to All when the selected sharer drops out of a refreshed list', async () => {
    const { rerender } = renderWithSharer();
    fireEvent.click(screen.getByRole('button', { name: 'Nightowl' }));
    rerender(viewWith([]));
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() =>
      expect(listLounge).toHaveBeenLastCalledWith({ query: undefined, owner: null }),
    );
  });
});

// Your own share's menu carries the owner moves that make sense from the
// Lounge: play it, pin it, and change who it reaches.

describe('LoungeView — own tile menu', () => {
  const OWN: LoungePlaylistItem = {
    ...FOREIGN,
    id: '33333333-3333-4333-8333-333333333333',
    name: 'My Mix',
    yours: true,
  };

  function renderOwn() {
    render(
      h(LoungeView, {
        initial: { playlists: [OWN, FOREIGN], nextCursor: null },
        sharers: [],
        viewerUserId: 'u-me',
        viewerIsAdmin: false,
      }),
    );
    fireEvent.click(screen.getByTestId(`lounge-menu-${OWN.id}`));
  }

  it('offers Play, Pin and Edit Sharing on your own tile', () => {
    renderOwn();
    expect(screen.getByText('Play')).toBeTruthy();
    expect(screen.getByTestId(`lounge-menu-pin-${OWN.id}`)).toBeTruthy();
    expect(screen.getByTestId(`lounge-menu-share-${OWN.id}`)).toBeTruthy();
    expect(screen.queryByTestId(`lounge-menu-more-like-this-${OWN.id}`)).toBeNull();
  });

  it('removes it from the Lounge only after a confirm, then drops the tile', async () => {
    sharePlaylist.mockResolvedValue({ ok: true, data: { playlistId: OWN.id, sharedAt: null } });
    renderOwn();
    fireEvent.click(screen.getByTestId(`lounge-menu-remove-from-lounge-${OWN.id}`));
    expect(sharePlaylist).not.toHaveBeenCalled();
    expect(screen.getByTestId('confirm-dialog').textContent).toContain('My Mix');

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() => expect(screen.queryByTestId(`lounge-tile-${OWN.id}`)).toBeNull());
    expect(sharePlaylist).toHaveBeenCalledWith(OWN.id, null);
    expect(screen.getByTestId(`lounge-tile-${FOREIGN.id}`)).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the tile and names the failure in an error toast when removing it fails', async () => {
    sharePlaylist.mockResolvedValue({ ok: false, error: { message: 'Network down.' } });
    renderOwn();
    fireEvent.click(screen.getByTestId(`lounge-menu-remove-from-lounge-${OWN.id}`));
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() =>
      expect(shownToasts()).toEqual([
        expect.objectContaining({
          tone: 'error',
          message: 'Removing it from the Lounge failed: Network down.',
        }),
      ]),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId(`lounge-tile-${OWN.id}`)).toBeTruthy();
  });

  it('drops the tile and refreshes the sharer cards when sharing returns it to Private', () => {
    renderOwn();
    fireEvent.click(screen.getByTestId(`lounge-menu-share-${OWN.id}`));
    fireEvent.click(screen.getByTestId('share-sheet-make-private'));
    expect(screen.queryByTestId(`lounge-tile-${OWN.id}`)).toBeNull();
    expect(screen.getByTestId(`lounge-tile-${FOREIGN.id}`)).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

// Someone else's share plays from its Lounge tile like your own does, read
// through the Lounge (the owner's playlist route refuses a visitor) and in
// the visitor scope, so the owner's play stamp stays untouched.

describe('LoungeView — playing a foreign share', () => {
  const MEMBER = { id: 't-1', audioUrl: '/api/tracks/t-1/audio' };
  const SUMMARY = { id: FOREIGN.id, name: FOREIGN.name };

  function renderForeign() {
    getLounge.mockResolvedValue({
      ok: true,
      data: { playlist: SUMMARY, items: [MEMBER], nextCursor: null },
    });
    getAllMembers.mockImplementation(
      async (_id: string, fetchPage: (cursor: null, limit: number) => Promise<unknown>) =>
        fetchPage(null, 100),
    );
    render(
      h(LoungeView, {
        initial: { playlists: [FOREIGN], nextCursor: null },
        sharers: [],
        viewerUserId: 'u-me',
        viewerIsAdmin: false,
      }),
    );
  }

  it('plays it from the tile through the Lounge read, in the visitor scope', async () => {
    renderForeign();
    fireEvent.click(screen.getByTestId(`lounge-play-${FOREIGN.id}`));
    await waitFor(() => expect(engagePlaylist).toHaveBeenCalledTimes(1));
    expect(getLounge).toHaveBeenCalledWith(FOREIGN.id, null, 100);
    expect(engagePlaylist).toHaveBeenCalledWith(SUMMARY, [MEMBER], null, { foreign: true });
  });

  it('opens the blocked dialog when More Like This from the tile has no headroom', async () => {
    const message = 'A new Session needs 5 Tracks; you have 4 left today.';
    seedMoreLikeThis.mockResolvedValue({
      ok: false,
      error: { code: 'session_headroom_blocked', message, retryable: false },
    });
    renderForeign();
    fireEvent.click(screen.getByTestId(`lounge-menu-${FOREIGN.id}`));
    fireEvent.click(screen.getByTestId(`lounge-menu-more-like-this-${FOREIGN.id}`));
    await waitFor(() => expect(shownCreationRefusal()).toEqual({ kind: 'headroom', message }));
    expect(shownToasts()).toEqual([]);
  });

  it('offers Play in its options menu', async () => {
    renderForeign();
    fireEvent.click(screen.getByTestId(`lounge-menu-${FOREIGN.id}`));
    fireEvent.click(screen.getByText('Play'));
    await waitFor(() => expect(engagePlaylist).toHaveBeenCalledTimes(1));
  });
});

// Paging on is an act on the room: a page that fails to arrive is reported as a
// toast, and the tiles already shown stay where they are.

describe('LoungeView — Load more', () => {
  it('reports a failed page as an error toast and keeps the loaded tiles', async () => {
    listLounge.mockResolvedValue({ ok: false, error: { message: 'Network down.' } });
    render(
      h(LoungeView, {
        initial: { playlists: [FOREIGN], nextCursor: 'next-page' },
        sharers: [],
        viewerUserId: 'u-viewer',
        viewerIsAdmin: false,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() =>
      expect(shownToasts()).toEqual([
        expect.objectContaining({
          tone: 'error',
          message: 'Couldn’t load more shared playlists: Network down.',
        }),
      ]),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId(`lounge-tile-${FOREIGN.id}`)).toBeTruthy();
  });
});
