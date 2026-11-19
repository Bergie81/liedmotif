// @vitest-environment jsdom

// Choosing the Playlist a Library selection goes into: a failed add floats
// above the sheet, which stays open on its list for another try, while the
// list itself failing to load stays in the sheet where the list would be.

import { createElement as h, type ComponentProps } from 'react';
import type { PlaylistSummaryItem } from '@liedmotif/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { ChoosePlaylistSheet } from './choose-playlist-sheet';

const holder = vi.hoisted(() => ({ loadFails: false, createWorks: false }));

vi.mock('@/lib/http/api-client', () => ({
  getAllPlaylists: async () =>
    holder.loadFails
      ? { ok: false as const, error: { code: 'internal_error', message: 'Offline.' } }
      : { ok: true as const, data: { playlists: [BEACH], nextCursor: null } },
  createPlaylist: async () =>
    holder.createWorks
      ? { ok: true as const, data: { playlist: { id: 'new-id', name: 'Road trip' } } }
      : { ok: false as const, error: { message: 'unused' } },
}));

afterEach(() => {
  toast.dismiss();
  cleanup();
  holder.loadFails = false;
  holder.createWorks = false;
});

const BEACH = {
  id: 'beach-id',
  name: 'Beach',
  kind: 'user',
  trackCount: 2,
  sharedAt: null,
} as PlaylistSummaryItem;

type AddResult = Awaited<ReturnType<ComponentProps<typeof ChoosePlaylistSheet>['onChoose']>>;

const failed = (message: string): AddResult => ({
  ok: false,
  error: { code: 'internal_error', message, retryable: false },
});
const landed: AddResult = {
  ok: true,
  data: { playlistId: 'beach-id', added: ['a', 'b', 'c'], refused: [] },
};

function openSheet(onChoose: (playlistId: string) => Promise<AddResult>) {
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
    const { onClose } = openSheet(async () => failed('Playlist is full.'));

    await choose();

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'error', message: 'Adding failed: Playlist is full.' }),
    ]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('choose-playlist-sheet')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clears the failure once a retry lands', async () => {
    const answers = [failed('Playlist is full.'), landed];
    const { onClose } = openSheet(async () => answers.shift() ?? landed);

    await choose();
    await choose();

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'success', message: 'Added 3 tracks to Beach' }),
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it('names a failed add into a playlist it just created as an add failure', async () => {
    holder.createWorks = true;
    openSheet(async () => failed('Network down.'));

    const newPlaylist = await screen.findByRole('button', { name: /New playlist/ });
    await act(async () => fireEvent.click(newPlaylist));
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'Road trip' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create' })));

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'error', message: 'Adding failed: Network down.' }),
    ]);
  });

  it('keeps a list that failed to load in the sheet, not in a toast', async () => {
    holder.loadFails = true;
    openSheet(async () => landed);

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Couldn’t load your playlists: Offline.',
    );
    expect(shownToasts()).toEqual([]);
  });
});
