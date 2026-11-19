// @vitest-environment jsdom

// Adding Tracks to a Playlist: a failed add or a failed "Load more" floats above
// the sheet, which stays open with what was picked. The first page of Tracks
// failing to load is the sheet's own content, so it stays in the sheet.

import { createElement as h } from 'react';
import type { LibraryTrackItem } from '@liedmotif/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { AddTracksSheet } from './add-tracks-sheet';

type Answer = 'refuse' | 'accept';

const holder = vi.hoisted(() => ({
  pages: [] as Answer[],
  adds: [] as Answer[],
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/api-client', () => ({
  getLibrary: async (_view: string, { cursor }: { cursor: string | null }) =>
    holder.pages.shift() === 'refuse'
      ? { ok: false as const, error: { code: 'internal_error', message: 'Offline.' } }
      : {
          ok: true as const,
          data: cursor
            ? { items: [track('track-2', 'Later')], nextCursor: null }
            : { items: [track('track-1', 'Calm')], nextCursor: 'page-2' },
        },
  addPlaylistTracks: async (_playlistId: string, trackIds: string[]) =>
    holder.adds.shift() === 'refuse'
      ? { ok: false as const, error: { code: 'internal_error', message: 'Offline.' } }
      : { ok: true as const, data: { playlistId: 'beach-id', added: trackIds, refused: [] } },
}));

afterEach(() => {
  toast.dismiss();
  cleanup();
  holder.pages = [];
  holder.adds = [];
});

function track(id: string, title: string): LibraryTrackItem {
  return { id, title, coverImageId: null, durationSeconds: 120 } as LibraryTrackItem;
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

const click = (element: HTMLElement) => act(async () => fireEvent.click(element));

describe('add tracks sheet', () => {
  it('floats a failed add above the sheet and keeps the picks', async () => {
    holder.adds = ['refuse'];
    const { onClose } = openSheet();

    await click(await screen.findByRole('checkbox', { name: /Calm/ }));
    await click(screen.getByTestId('add-tracks-commit'));

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'error', message: 'Adding failed: Offline.' }),
    ]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('checkbox', { name: /Calm/ }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clears the failure once a retry lands', async () => {
    holder.adds = ['refuse', 'accept'];
    const { onClose } = openSheet();

    await click(await screen.findByRole('checkbox', { name: /Calm/ }));
    await click(screen.getByTestId('add-tracks-commit'));
    await click(screen.getByTestId('add-tracks-commit'));

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'success', message: 'Added 1 track to Beach' }),
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it('floats a failed Load more and keeps the Tracks already shown', async () => {
    holder.pages = ['accept', 'refuse', 'accept'];
    openSheet();

    await click(await screen.findByRole('button', { name: 'Load more' }));

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'error', message: 'Couldn’t load more Tracks: Offline.' }),
    ]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('checkbox', { name: /Calm/ })).toBeTruthy();

    await click(screen.getByRole('button', { name: 'Load more' }));

    expect(shownToasts()).toEqual([]);
    expect(screen.getByRole('checkbox', { name: /Later/ })).toBeTruthy();
  });

  it('keeps a first page that failed to load in the sheet, not in a toast', async () => {
    holder.pages = ['refuse'];
    openSheet();

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Couldn’t load your tracks: Offline.',
    );
    expect(shownToasts()).toEqual([]);
  });
});
