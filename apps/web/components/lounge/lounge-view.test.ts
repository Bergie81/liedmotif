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
import { LoungeView } from './lounge-view';

const moderate = vi.hoisted(() => vi.fn());
const listLounge = vi.hoisted(() => vi.fn());
const pinLounge = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api-client', () => ({
  getAllPlaylistMembers: vi.fn(),
  getLoungePlaylist: vi.fn(),
  listLoungePlaylists: listLounge,
  pinLoungePlaylist: pinLounge,
  markPlaylistPlayed: vi.fn(),
  moreLikeThis: vi.fn(),
  moderateLoungePlaylist: moderate,
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
  moderate.mockReset();
  listLounge.mockReset();
  pinLounge.mockReset();
  refresh.mockReset();
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
    expect(dialog.textContent).toContain('Pins');
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

  it('keeps the order and names the failure when the pin is refused', async () => {
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

    await waitFor(() => expect(screen.getByText(/Couldn’t pin the playlist/)).toBeTruthy());
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
    expect(screen.getByRole('button', { name: 'Everyone' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    await waitFor(() =>
      expect(listLounge).toHaveBeenLastCalledWith({ query: undefined, owner: null }),
    );
  });

  it('falls back to Everyone when the selected sharer drops out of a refreshed list', async () => {
    const { rerender } = renderWithSharer();
    fireEvent.click(screen.getByRole('button', { name: 'Nightowl' }));
    rerender(viewWith([]));
    expect(screen.getByRole('button', { name: 'Everyone' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    await waitFor(() =>
      expect(listLounge).toHaveBeenLastCalledWith({ query: undefined, owner: null }),
    );
  });
});
