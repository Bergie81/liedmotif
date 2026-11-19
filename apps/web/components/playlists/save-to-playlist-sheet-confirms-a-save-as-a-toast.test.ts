// @vitest-environment jsdom

// A save closes the picker, so nothing on screen says where the Track went:
// one toast names the change the commit made, however many Playlists it touched.

import { createElement as h } from 'react';
import type { PlaylistSummaryItem } from '@liedmotif/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { SaveToPlaylistSheet } from './save-to-playlist-sheet';

const holder = vi.hoisted(() => ({ playlists: [] as unknown[] }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/http/api-client', () => ({
  getAllPlaylists: async () => ({
    ok: true as const,
    data: { playlists: holder.playlists, nextCursor: null },
  }),
  applyTrackMemberships: async (input: { trackId: string; playlistIds: string[] }) => ({
    ok: true as const,
    data: { trackId: input.trackId, playlistIds: input.playlistIds, flags: {} },
  }),
}));

afterEach(() => {
  toast.dismiss();
  cleanup();
  holder.playlists = [];
});

function playlist(name: string, containsTrack = false): PlaylistSummaryItem {
  return {
    id: `${name}-id`,
    name,
    kind: 'user',
    listedInPlaylists: true,
    trackCount: 2,
    containsTrack,
    sharedAt: null,
  } as PlaylistSummaryItem;
}

function openPicker(savedAt: string | null = null) {
  const onClose = vi.fn();
  render(
    h(SaveToPlaylistSheet, {
      track: { id: 'track-1', title: 'Calm', savedAt, coverImageId: null },
      onClose,
      onApplied: vi.fn(),
    }),
  );
  return { onClose };
}

const toggle = async (name: string) =>
  fireEvent.click(await screen.findByRole('checkbox', { name: new RegExp(name) }));
const save = () => act(async () => fireEvent.click(screen.getByTestId('picker-commit')));

describe('save picker — a landed save', () => {
  it('names the one Playlist the Track was saved to', async () => {
    holder.playlists = [playlist('Night Drive'), playlist('Focus')];
    const { onClose } = openPicker();

    await toggle('Night Drive');
    await save();

    expect(onClose).toHaveBeenCalled();
    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'success', message: 'Saved to Night Drive' }),
    ]);
  });

  it('names a Playlist the save created', async () => {
    holder.playlists = [playlist('Focus')];
    openPicker();

    fireEvent.click(await screen.findByTestId('picker-new-playlist'));
    fireEvent.change(screen.getByLabelText('New playlist name'), {
      target: { value: '  Rainy Sunday ' },
    });
    await save();

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'success', message: 'Saved to Rainy Sunday' }),
    ]);
  });

  it('shows one toast that counts the Playlists when the save reached several', async () => {
    holder.playlists = [playlist('Night Drive'), playlist('Focus')];
    openPicker();

    await toggle('Night Drive');
    await toggle('Focus');
    await save();

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'success', message: 'Saved to 2 playlists' }),
    ]);
  });

  it('names only where the Track went when the same save also took it out of one', async () => {
    holder.playlists = [playlist('Night Drive'), playlist('Focus', true)];
    openPicker('2026-11-01T10:00:00.000Z');

    await toggle('Focus');
    await toggle('Night Drive');
    await save();

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'success', message: 'Saved to Night Drive' }),
    ]);
  });

  it('names the Playlist a save took the Track out of', async () => {
    holder.playlists = [playlist('Night Drive', true), playlist('Focus', true)];
    openPicker('2026-11-01T10:00:00.000Z');

    await toggle('Focus');
    await save();

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'success', message: 'Removed from Focus' }),
    ]);
  });

  // An unsave shows itself the way the Unsave action does: the Track leaves
  // the Saved view.
  it('stays silent when the save emptied every Playlist', async () => {
    holder.playlists = [playlist('Night Drive', true), playlist('Focus', true)];
    const { onClose } = openPicker('2026-11-01T10:00:00.000Z');

    await toggle('Night Drive');
    await toggle('Focus');
    await save();

    expect(onClose).toHaveBeenCalled();
    expect(shownToasts()).toEqual([]);
  });

  it('stays silent when the save changed nothing', async () => {
    holder.playlists = [playlist('Night Drive', true)];
    const { onClose } = openPicker('2026-11-01T10:00:00.000Z');

    await screen.findByRole('checkbox', { name: /Night Drive/ });
    await save();

    expect(onClose).toHaveBeenCalled();
    expect(shownToasts()).toEqual([]);
  });
});
