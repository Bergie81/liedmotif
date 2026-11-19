// @vitest-environment jsdom

// The Add Tracks sheet's search box asks the Library for matching Tracks (track
// titles, prompts, genres and moods, matched server-side), so a Track not on the
// first page is still findable. Picks survive a search, so tracks found
// through different queries go in one add.

import { createElement as h } from 'react';
import type { LibraryTrackItem } from '@liedmotif/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@/lib/toast';
import { AddTracksSheet } from './add-tracks-sheet';

const server = vi.hoisted(() => ({
  calls: [] as Array<{ search?: string; cursor?: string | null }>,
  added: [] as string[][],
  /** The unsearched first page says more follow, so Load more shows. */
  paged: false,
  /** A search that answers only once released. */
  held: null as null | { search: string; release?: () => void },
}));

const track = (id: string, title: string, sessionTitle: string) =>
  ({ id, title, sessionTitle, coverImageId: null, durationSeconds: 120 }) as LibraryTrackItem & {
    sessionTitle: string;
  };

const TRACKS = [
  track('t-rain', 'Rain on Glass', 'Late Night Focus'),
  track('t-sun', 'Morning Sun', 'Sunday Run'),
  track('t-drift', 'Drift', 'Late Night Focus'),
];

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/http/api-client', () => ({
  getLibrary: async (_view: string, options: { search?: string; cursor?: string | null } = {}) => {
    server.calls.push({ search: options.search, cursor: options.cursor });
    if (server.held && options.search === server.held.search && !options.cursor) {
      const held = server.held;
      await new Promise<void>((resolve) => (held.release = resolve));
    }
    const needle = options.search?.toLowerCase();
    const items = needle
      ? TRACKS.filter(
          (t) =>
            t.title!.toLowerCase().includes(needle) ||
            t.sessionTitle.toLowerCase().includes(needle),
        )
      : TRACKS;
    const more = server.paged && !needle && !options.cursor;
    return { ok: true as const, data: { items, nextCursor: more ? 'c-1' : null } };
  },
  addPlaylistTracks: async (playlistId: string, trackIds: string[]) => {
    server.added.push(trackIds);
    return { ok: true as const, data: { playlistId, added: trackIds, refused: [] } };
  },
}));

afterEach(() => {
  toast.dismiss();
  cleanup();
  server.calls = [];
  server.added = [];
  server.paged = false;
  server.held = null;
});

const rows = () =>
  screen.getAllByRole('checkbox').map((row) => row.textContent?.replace(/\d+:\d+$/, '') ?? '');

async function renderSheet() {
  render(
    h(AddTracksSheet, {
      open: true,
      playlistId: 'p-1',
      playlistName: 'Focus',
      existingTrackIds: [],
      onClose: () => {},
      onAdded: () => {},
    }),
  );
  await screen.findByText('Rain on Glass');
}

const search = (value: string) =>
  fireEvent.change(
    screen.getByRole('searchbox', { name: 'Search titles, prompts, genres, moods…' }),
    {
      target: { value },
    },
  );

describe('Add Tracks search', () => {
  it('asks the Library for the query and lists only what matches', async () => {
    await renderSheet();

    search('late night');
    await waitFor(() => expect(screen.queryByText('Morning Sun')).toBeNull(), { timeout: 2000 });

    expect(server.calls.at(-1)?.search).toBe('late night');
    expect(rows()).toEqual(['Rain on Glass', 'Drift']);
  });

  it('keeps picks across searches and adds them together', async () => {
    await renderSheet();

    search('rain');
    await waitFor(() => expect(screen.queryByText('Drift')).toBeNull(), { timeout: 2000 });
    fireEvent.click(screen.getByText('Rain on Glass'));

    search('sunday');
    await screen.findByText('Morning Sun', {}, { timeout: 2000 });
    fireEvent.click(screen.getByText('Morning Sun'));

    await act(async () => fireEvent.click(screen.getByTestId('add-tracks-commit')));
    await waitFor(() => expect(server.added).toEqual([['t-rain', 't-sun']]));
  });

  it('never pages a new search with the cursor of the list it replaces', async () => {
    server.paged = true;
    server.held = { search: 'late' };
    await renderSheet();

    search('late');
    await waitFor(() => expect(server.held?.release).toBeDefined(), { timeout: 2000 });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await act(async () => server.held!.release!());

    await waitFor(() => expect(screen.queryByText('Morning Sun')).toBeNull());
    expect(server.calls.filter((call) => call.cursor)).toEqual([]);
    expect(rows()).toEqual(['Rain on Glass', 'Drift']);
  });

  it('says so when no Track matches', async () => {
    await renderSheet();
    search('zed');
    expect(await screen.findByText('No tracks match “zed”.', {}, { timeout: 2000 })).toBeTruthy();
  });
});
