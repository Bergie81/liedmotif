// @vitest-environment jsdom

// The Add Tracks sheet sends more than 100 picks as consecutive adds of at most
// 100. A failed later batch keeps what earlier batches added (the Playlist
// reloads to show it) and the picks, so a retry adds only what is missing.

import { createElement as h } from 'react';
import type { LibraryTrackItem } from '@liedmotif/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { AddTracksSheet } from './add-tracks-sheet';

const server = vi.hoisted(() => ({
  playlist: [] as string[],
  requests: [] as string[][],
  failOnRequest: null as number | null,
}));

const TRACKS = Array.from(
  { length: 101 },
  (_, i) =>
    ({
      id: `track-${i + 1}`,
      title: `Song ${i + 1}`,
      coverImageId: null,
      durationSeconds: 120,
    }) as LibraryTrackItem,
);

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/api-client', () => ({
  getLibrary: async () => ({ ok: true as const, data: { items: TRACKS, nextCursor: null } }),
  addPlaylistTracks: async (playlistId: string, trackIds: string[]) => {
    server.requests.push(trackIds);
    if (server.requests.length === server.failOnRequest) {
      return {
        ok: false as const,
        error: { code: 'internal_error', message: 'Offline.', retryable: true },
      };
    }
    const added = trackIds.filter((id) => !server.playlist.includes(id));
    server.playlist.push(...added);
    return { ok: true as const, data: { playlistId, added, refused: [] } };
  },
}));

afterEach(() => {
  toast.dismiss();
  cleanup();
  server.playlist = [];
  server.requests = [];
  server.failOnRequest = null;
});

const click = (element: HTMLElement) => act(async () => fireEvent.click(element));

async function pickAll() {
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
  for (const box of await screen.findAllByRole('checkbox')) await click(box);
  return { onClose, onAdded };
}

describe('add tracks sheet batches', () => {
  it('adds 101 picks as batches of 100 and 1 in the picked order', async () => {
    const { onClose, onAdded } = await pickAll();

    await click(screen.getByTestId('add-tracks-commit'));

    expect(server.requests.map((request) => request.length)).toEqual([100, 1]);
    expect(server.playlist).toEqual(TRACKS.map((track) => track.id));
    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'success', message: 'Added 101 tracks to Beach' }),
    ]);
    expect(onAdded).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps what landed and the picks when a later batch fails, then retries the rest', async () => {
    server.failOnRequest = 2;
    const { onClose, onAdded } = await pickAll();

    await click(screen.getByTestId('add-tracks-commit'));

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'error', message: 'Adding failed: Offline.' }),
    ]);
    expect(onAdded).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('add-tracks-commit').textContent).toBe('Add 101');

    await click(screen.getByTestId('add-tracks-commit'));

    expect(server.playlist).toEqual(TRACKS.map((track) => track.id));
    expect(onClose).toHaveBeenCalled();
  });

  it('reloads nothing when the first batch fails', async () => {
    server.failOnRequest = 1;
    const { onAdded } = await pickAll();

    await click(screen.getByTestId('add-tracks-commit'));

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'error', message: 'Adding failed: Offline.' }),
    ]);
    expect(onAdded).not.toHaveBeenCalled();
    expect(server.playlist).toEqual([]);
  });
});
