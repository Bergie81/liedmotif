// @vitest-environment jsdom

// Choosing the Playlist a Library selection goes into: a failed add floats
// above the sheet, which stays open on its list for another try, while the
// list itself failing to load stays in the sheet where the list would be.

import { createElement as h } from 'react';
import type { PlaylistSummaryItem } from '@liedmotif/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { ChoosePlaylistSheet } from './choose-playlist-sheet';

const holder = vi.hoisted(() => ({ loadFails: false }));

vi.mock('@/lib/api-client', () => ({
  getAllPlaylists: async () =>
    holder.loadFails
      ? { ok: false as const, error: { code: 'internal_error', message: 'Offline.' } }
      : { ok: true as const, data: { playlists: [BEACH], nextCursor: null } },
  createPlaylist: async () => ({ ok: false as const, error: { message: 'unused' } }),
}));

afterEach(() => {
  toast.dismiss();
  cleanup();
  holder.loadFails = false;
});

const BEACH = {
  id: 'beach-id',
  name: 'Beach',
  kind: 'user',
  trackCount: 2,
  sharedAt: null,
} as PlaylistSummaryItem;

function openSheet(onChoose: (playlistId: string) => Promise<string | null>) {
  const onClose = vi.fn();
  render(h(ChoosePlaylistSheet, { open: true, trackCount: 3, onClose, onChoose }));
  return { onClose };
}

const choose = async () => {
  const row = await screen.findByRole('button', { name: /Beach/ });
  await act(async () => fireEvent.click(row));
};

describe('choose playlist sheet', () => {
  it('floats a failed add above the sheet and keeps the list open', async () => {
    const { onClose } = openSheet(async () => 'Playlist is full.');

    await choose();

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'error', message: 'Playlist is full.' }),
    ]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('choose-playlist-sheet')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clears the failure once a retry lands', async () => {
    const answers = ['Playlist is full.', null];
    const { onClose } = openSheet(async () => answers.shift() ?? null);

    await choose();
    await choose();

    expect(shownToasts()).toEqual([]);
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps a list that failed to load in the sheet, not in a toast', async () => {
    holder.loadFails = true;
    openSheet(async () => null);

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Couldn’t load your playlists: Offline.',
    );
    expect(shownToasts()).toEqual([]);
  });
});
