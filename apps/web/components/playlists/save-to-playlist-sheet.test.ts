// @vitest-environment jsdom

// The save picker's retention contract (retention is membership):
// the list offers the playlists the owner curates, a membership it never offers
// rides the commit untouched, and unchecking the list is Unsave — the empty set,
// which the commit button renames itself to announce.

import { createElement as h } from 'react';
import type { PlaylistSummaryItem } from '@liedmotif/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SaveToPlaylistSheet, type SavePickerTrack } from './save-to-playlist-sheet';

interface Commit {
  trackId: string;
  playlistIds: string[];
  createPlaylistName?: string | null;
}

const holder = vi.hoisted(() => ({
  playlists: [] as unknown[],
  commits: [] as unknown[],
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/api-client', () => ({
  getAllPlaylists: async () => ({
    ok: true as const,
    data: { playlists: holder.playlists, nextCursor: null },
  }),
  applyTrackMemberships: async (input: Commit) => {
    holder.commits.push(input);
    return {
      ok: true as const,
      data: {
        trackId: input.trackId,
        playlistIds: input.playlistIds,
        createdPlaylistId: null,
        flags: {
          trackId: input.trackId,
          savedAt: input.playlistIds.length > 0 ? '2026-07-25T10:00:00.000Z' : null,
          favoritedAt: null,
          dislikedAt: null,
          retentionClass: input.playlistIds.length > 0 ? 'durable' : 'ephemeral',
        },
      },
    };
  },
}));

afterEach(() => {
  cleanup();
  holder.playlists = [];
  holder.commits = [];
});

const TRACK: SavePickerTrack = {
  id: 'track-1',
  title: 'KI statt Gute Nacht',
  savedAt: '2026-07-20T10:00:00.000Z',
  coverImageId: null,
};

function playlist(over: Partial<PlaylistSummaryItem> & { id: string }): PlaylistSummaryItem {
  return {
    name: over.id,
    kind: 'user',
    listedInPlaylists: true,
    trackCount: 2,
    totalDurationSeconds: 360,
    downloadableTrackCount: 0,
    coverImageId: null,
    mosaicCoverImageIds: [],
    soleMemberTrackCount: 0,
    soleMemberDeletedTrackCount: 0,
    containsTrack: false,
    sharedAt: null,
    pinnedAt: null,
    createdAt: '2026-07-20T10:00:00.000Z',
    updatedAt: '2026-07-20T10:00:00.000Z',
    ...over,
  };
}

/** A Track filed in Favorites, in an unlisted collection, and in one of two
 *  curated playlists — the membership kinds the commit has to tell apart. */
const PLAYLISTS: PlaylistSummaryItem[] = [
  playlist({
    id: 'favorites-id',
    name: 'Favorites',
    kind: 'favorites',
    listedInPlaylists: false,
    containsTrack: true,
  }),
  playlist({
    id: 'unlisted-id',
    name: 'Saved tracks',
    listedInPlaylists: false,
    containsTrack: true,
  }),
  playlist({ id: 'beach-id', name: 'Beach', containsTrack: true }),
  playlist({ id: 'focus-id', name: 'Focus' }),
];

async function renderPicker(
  playlists: PlaylistSummaryItem[] = PLAYLISTS,
  track: SavePickerTrack = TRACK,
): Promise<void> {
  holder.playlists = playlists;
  render(h(SaveToPlaylistSheet, { track, onClose: () => {}, onApplied: () => {} }));
  await screen.findByTestId('picker-commit');
}

const commitButton = () => screen.getByTestId('picker-commit') as HTMLButtonElement;
const lastCommit = () => holder.commits.at(-1) as Commit;

describe('save picker', () => {
  it('offers the curated playlists only', async () => {
    await renderPicker();

    expect(screen.getAllByTestId('picker-playlist').map((row) => row.textContent)).toEqual([
      expect.stringContaining('Beach'),
      expect.stringContaining('Focus'),
    ]);
    expect(screen.queryByText('Favorites')).toBeNull();
    expect(screen.queryByText('Saved tracks')).toBeNull();
  });

  it('heads the list with New playlist, before any playlist the owner has', async () => {
    await renderPicker();

    const list = screen.getByRole('group', { name: 'Playlists' });
    expect(list.firstElementChild).toBe(screen.getByTestId('picker-new-playlist'));
  });

  it('opens with the curated memberships checked and nothing else', async () => {
    await renderPicker();

    const rows = screen.getAllByTestId('picker-playlist');
    expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual(['true', 'false']);
  });

  it('carries a membership the list never offered through the commit', async () => {
    await renderPicker();

    fireEvent.click(commitButton());

    await waitFor(() => expect(holder.commits).toHaveLength(1));
    expect([...lastCommit().playlistIds].sort()).toEqual([
      'beach-id',
      'favorites-id',
      'unlisted-id',
    ]);
  });

  it('unchecking the list is Unsave: the button renames itself, then commits the empty set', async () => {
    await renderPicker();

    fireEvent.click(screen.getAllByTestId('picker-playlist')[0]!);

    expect(commitButton().textContent).toContain('Remove from Library');

    fireEvent.click(commitButton());

    await waitFor(() => expect(holder.commits).toHaveLength(1));
    expect(lastCommit().playlistIds).toEqual([]);
  });

  it('has nothing to commit for an unsaved Track until something is chosen', async () => {
    await renderPicker([playlist({ id: 'focus-id', name: 'Focus' })], { ...TRACK, savedAt: null });

    expect(commitButton().disabled).toBe(true);

    fireEvent.click(screen.getByTestId('picker-playlist'));

    expect(commitButton().disabled).toBe(false);
  });
});
