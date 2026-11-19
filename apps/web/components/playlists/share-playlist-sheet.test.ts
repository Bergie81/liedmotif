// @vitest-environment jsdom

// The share picker's wiring: it opens on the playlist's current audience and
// sends exactly what the ticks mean — the rules themselves are the view
// model's and are covered there.

import { createElement as h } from 'react';
import type { PlaylistSummaryItem, ShareAudience } from '@liedmotif/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { SharePlaylistSheet, type ShareResult } from './share-playlist-sheet';

const holder = vi.hoisted(() => ({
  audience: null as unknown,
  writes: [] as unknown[],
  refusals: 0,
}));

vi.mock('@/lib/http/api-client', () => ({
  getPlaylistShare: async (playlistId: string) => ({
    ok: true as const,
    data: {
      playlistId,
      audience: holder.audience,
      candidates: [
        { userId: 'u-anna', name: 'Anna Schmidt', artistName: 'Nightowl', imageUrl: null },
        { userId: 'u-jonas', name: 'Jonas Weber', artistName: null, imageUrl: null },
      ],
    },
  }),
  sharePlaylist: async (playlistId: string, audience: ShareAudience | null) => {
    holder.writes.push(audience);
    if (holder.refusals > 0) {
      holder.refusals -= 1;
      return { ok: false as const, error: { code: 'internal_error', message: 'Offline.' } };
    }
    return {
      ok: true as const,
      data: { playlistId, sharedAt: audience ? '2026-10-31T10:00:00.000Z' : null, audience },
    };
  },
}));

afterEach(() => {
  toast.dismiss();
  cleanup();
  holder.audience = null;
  holder.writes = [];
  holder.refusals = 0;
});

const PLAYLIST: PlaylistSummaryItem = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Focus',
  kind: 'user',
  listedInPlaylists: true,
  trackCount: 2,
  totalDurationSeconds: 360,
  downloadableTrackCount: 0,
  coverImageId: null,
  mosaicCoverImageIds: [],
  soleMemberTrackCount: 0,
  soleMemberDeletedTrackCount: 0,
  containsTrack: null,
  sharedAt: '2026-10-30T10:00:00.000Z',
  pinnedAt: null,
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-20T10:00:00.000Z',
};

async function renderSheet(
  onShared: (result: ShareResult) => void = () => {},
  onClose: () => void = () => {},
) {
  render(h(SharePlaylistSheet, { playlist: PLAYLIST, onClose, onShared }));
  await screen.findByTestId('share-candidate-u-anna');
}

const checked = (userId: string) =>
  screen.getByTestId(`share-candidate-${userId}`).getAttribute('aria-checked');

describe('share picker', () => {
  it('opens a playlist shared with everyone on All, and narrowing it sends the rest', async () => {
    holder.audience = { kind: 'everyone' };
    await renderSheet();

    expect([checked('u-anna'), checked('u-jonas')]).toEqual(['true', 'true']);
    expect(screen.getByTestId('share-select-all').getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByTestId('share-candidate-u-jonas'));
    fireEvent.click(screen.getByTestId('share-commit'));

    await waitFor(() => expect(holder.writes).toEqual([{ kind: 'selected', userIds: ['u-anna'] }]));
  });

  it('names a User by full name under an artist name, so two alike labels stay apart', async () => {
    await renderSheet();
    expect(screen.getByTestId('share-candidate-u-anna').textContent).toContain('Anna Schmidt');
  });

  it('None on a shared playlist returns it to Private and reports the cleared share', async () => {
    holder.audience = { kind: 'selected', userIds: ['u-anna'] };
    const onShared = vi.fn();
    await renderSheet(onShared);

    fireEvent.click(screen.getByTestId('share-select-none'));
    expect(screen.getByTestId('share-commit').textContent).toBe('Return to Private');
    fireEvent.click(screen.getByTestId('share-commit'));

    await waitFor(() =>
      expect(onShared).toHaveBeenCalledWith({ playlistId: PLAYLIST.id, sharedAt: null }),
    );
    expect(holder.writes).toEqual([null]);
  });

  it('floats a refused share above the sheet and keeps the picks for another try', async () => {
    holder.audience = { kind: 'everyone' };
    holder.refusals = 1;
    const onShared = vi.fn();
    const onClose = vi.fn();
    await renderSheet(onShared, onClose);

    fireEvent.click(screen.getByTestId('share-candidate-u-jonas'));
    fireEvent.click(screen.getByTestId('share-commit'));

    await waitFor(() =>
      expect(shownToasts()).toEqual([
        expect.objectContaining({ tone: 'error', message: 'Sharing failed: Offline.' }),
      ]),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect([checked('u-anna'), checked('u-jonas')]).toEqual(['true', 'false']);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('share-commit'));

    await waitFor(() => expect(onShared).toHaveBeenCalled());
    expect(shownToasts()).toEqual([]);
  });

  it('narrows the list by name or artist name without changing what All sends', async () => {
    await renderSheet();
    const search = screen.getByRole('searchbox', { name: 'Search people' });

    fireEvent.change(search, { target: { value: 'night' } });
    expect(screen.getByTestId('share-candidate-u-anna')).toBeTruthy();
    expect(screen.queryByTestId('share-candidate-u-jonas')).toBeNull();

    fireEvent.change(search, { target: { value: 'weber' } });
    expect(screen.queryByTestId('share-candidate-u-anna')).toBeNull();
    fireEvent.click(screen.getByTestId('share-candidate-u-jonas'));
    fireEvent.click(screen.getByTestId('share-commit'));

    await waitFor(() =>
      expect(holder.writes).toEqual([{ kind: 'selected', userIds: ['u-jonas'] }]),
    );

    fireEvent.click(screen.getByTestId('share-select-all'));
    fireEvent.click(screen.getByTestId('share-commit'));

    await waitFor(() => expect(holder.writes.at(-1)).toEqual({ kind: 'everyone' }));
  });

  it('says so when nobody matches the search', async () => {
    await renderSheet();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search people' }), {
      target: { value: 'zed' },
    });
    expect(screen.getByText('No one matches “zed”.')).toBeTruthy();
  });
});
