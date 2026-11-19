// @vitest-environment jsdom

// Adding a Library selection closes the sheet, so a toast says how many Tracks
// went into which Playlist — a chosen one or one made on the way. The count is
// what the add appended: a selected Track already in the Playlist adds nothing.

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

function landed(added: number, refused = 0) {
  return {
    ok: true as const,
    data: {
      playlistId: 'beach-id',
      added: Array.from({ length: added }, (_, i) => `track-${i}`),
      refused: Array.from({ length: refused }, (_, i) => `gone-${i}`),
    },
  };
}

function openSheet(trackCount: number, added = trackCount, refused = 0) {
  const onClose = vi.fn();
  const onChoose = vi.fn(async () => landed(added, refused));
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

  it('counts only the Tracks the add appended', async () => {
    openSheet(3, 1);

    await click(await screen.findByRole('button', { name: /Beach/ }));

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'success', message: 'Added 1 track to Beach' }),
    ]);
  });

  it('says the Tracks were already there when the add appended none', async () => {
    openSheet(2, 0);

    await click(await screen.findByRole('button', { name: /Beach/ }));

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'success', message: 'Already in Beach' }),
    ]);
  });

  it('warns about the Tracks the server refused next to the ones it added', async () => {
    openSheet(3, 2, 1);

    await click(await screen.findByRole('button', { name: /Beach/ }));

    expect(shownToasts()).toEqual([
      expect.objectContaining({
        tone: 'warning',
        message: 'Added 2 tracks to Beach · 1 could not be added',
      }),
    ]);
  });

  it('reports an add the server refused entirely as a failure, not as already there', async () => {
    openSheet(2, 0, 2);

    await click(await screen.findByRole('button', { name: /Beach/ }));

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'error', message: 'Could not add 2 tracks to Beach' }),
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
