// @vitest-environment jsdom

// An add closes the sheet, so a toast says how many Tracks went into which
// Playlist. An add that failed partway reports only the failure: the sheet stays
// open with the picks, and the retry that finishes it is what confirms.

import { createElement as h } from 'react';
import type { LibraryTrackItem } from '@liedmotif/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { AddTracksSheet } from './add-tracks-sheet';

const holder = vi.hoisted(() => ({
  tracks: [] as unknown[],
  adds: [] as Array<'refuse' | 'accept'>,
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/api-client', () => ({
  getLibrary: async () => ({ ok: true as const, data: { items: holder.tracks, nextCursor: null } }),
  addPlaylistTracks: async () =>
    holder.adds.shift() === 'refuse'
      ? { ok: false as const, error: { code: 'internal_error', message: 'Offline.' } }
      : { ok: true as const, data: { playlistId: 'beach-id', added: [], refused: [] } },
}));

afterEach(() => {
  toast.dismiss();
  cleanup();
  holder.tracks = [];
  holder.adds = [];
});

function tracks(count: number): LibraryTrackItem[] {
  return Array.from(
    { length: count },
    (_, index) =>
      ({
        id: `track-${index}`,
        title: `Track ${index}`,
        coverImageId: null,
        durationSeconds: 120,
      }) as LibraryTrackItem,
  );
}

function openSheet() {
  const onClose = vi.fn();
  const onAdded = vi.fn();
  render(
    h(AddTracksSheet, {
      open: true,
      playlistId: 'beach-id',
      playlistName: 'Beach',
      existingTrackIds: [],
      onClose,
      onAdded,
    }),
  );
  return { onClose, onAdded };
}

async function pick(count: number) {
  await screen.findAllByRole('checkbox');
  for (const box of screen.getAllByRole('checkbox').slice(0, count)) fireEvent.click(box);
}
const add = () => act(async () => fireEvent.click(screen.getByTestId('add-tracks-commit')));

describe('add tracks sheet — a landed add', () => {
  it('counts one Track in the singular', async () => {
    holder.tracks = tracks(3);
    const { onClose } = openSheet();

    await pick(1);
    await add();

    expect(onClose).toHaveBeenCalled();
    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'success', message: 'Added 1 track to Beach' }),
    ]);
  });

  it('counts several Tracks in the plural', async () => {
    holder.tracks = tracks(3);
    openSheet();

    await pick(3);
    await add();

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'success', message: 'Added 3 tracks to Beach' }),
    ]);
  });

  it('reports only the failure when a later batch is refused, and confirms the retry', async () => {
    holder.tracks = tracks(101);
    holder.adds = ['accept', 'refuse'];
    const { onClose, onAdded } = openSheet();

    await pick(101);
    await add();

    expect(onAdded).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'error', message: 'Adding failed: Offline.' }),
    ]);

    await add();

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'success', message: 'Added 101 tracks to Beach' }),
    ]);
  });
});

describe('add tracks sheet — a failed Track', () => {
  it('lists it with its notice and offers no way to pick it', async () => {
    holder.tracks = [
      ...tracks(1),
      {
        id: 'failed',
        title: 'Lost',
        coverImageId: null,
        durationSeconds: 120,
        status: 'failed',
      } as LibraryTrackItem,
    ];
    openSheet();

    const boxes = await screen.findAllByRole('checkbox');
    const failed = boxes.find((box) => box.textContent?.includes('Lost'))!;
    expect(failed.textContent).toContain('Could not be kept');
    expect((failed as HTMLButtonElement).disabled).toBe(true);
  });
});
