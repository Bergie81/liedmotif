// @vitest-environment jsdom

// Adding a Library selection closes the sheet, so a toast says how many Tracks
// went into which Playlist — a chosen one or one made on the way.

import { createElement as h } from 'react';
import type { PlaylistSummaryItem } from '@liedmotif/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { ChoosePlaylistSheet } from './choose-playlist-sheet';

vi.mock('@/lib/api-client', () => ({
  getAllPlaylists: async () => ({
    ok: true as const,
    data: { playlists: [BEACH], nextCursor: null },
  }),
  createPlaylist: async () => ({
    ok: true as const,
    data: { playlist: { id: 'night-drive-id' } },
  }),
}));

afterEach(() => {
  toast.dismiss();
  cleanup();
});

const BEACH = {
  id: 'beach-id',
  name: 'Beach',
  kind: 'user',
  trackCount: 2,
  sharedAt: null,
} as PlaylistSummaryItem;

function openSheet(trackCount: number) {
  const onClose = vi.fn();
  const onChoose = vi.fn(async () => null);
  render(h(ChoosePlaylistSheet, { open: true, trackCount, onClose, onChoose }));
  return { onClose, onChoose };
}

const click = (element: HTMLElement) => act(async () => fireEvent.click(element));

describe('choose playlist sheet — a landed add', () => {
  it('names the chosen Playlist and counts several Tracks in the plural', async () => {
    const { onClose } = openSheet(3);

    await click(await screen.findByRole('button', { name: /Beach/ }));

    expect(onClose).toHaveBeenCalled();
    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'success', message: 'Added 3 tracks to Beach' }),
    ]);
  });

  it('counts one Track in the singular', async () => {
    openSheet(1);

    await click(await screen.findByRole('button', { name: /Beach/ }));

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'success', message: 'Added 1 track to Beach' }),
    ]);
  });

  it('names a Playlist made on the way', async () => {
    const { onChoose } = openSheet(2);

    await click(await screen.findByRole('button', { name: /New playlist/ }));
    fireEvent.change(await screen.findByLabelText('New name'), {
      target: { value: 'Night Drive' },
    });
    await click(screen.getByRole('button', { name: 'Create' }));

    expect(onChoose).toHaveBeenCalledWith('night-drive-id');
    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'success', message: 'Added 2 tracks to Night Drive' }),
    ]);
  });
});
