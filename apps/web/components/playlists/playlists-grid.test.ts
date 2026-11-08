import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isCuratedPlaylist, type PlaylistSummaryItem } from '@liedmotif/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PlaylistsGridContent } from './playlists-grid';

/** The cover URL each `img` actually requests, unwrapped from the Next image
 *  optimizer indirection when the test render goes through it. */
function coverRequests(markup: string): string[] {
  return [...markup.matchAll(/<img[^>]*\bsrc="([^"]+)"/g)].map((match) => {
    const src = match[1]!.replace(/&amp;/g, '&');
    if (!src.startsWith('/_next/image')) return src;
    return new URLSearchParams(src.slice(src.indexOf('?') + 1)).get('url') ?? '';
  });
}

const basePlaylist = {
  trackCount: 2,
  totalDurationSeconds: 360,
  downloadableTrackCount: 2,
  kind: 'user' as const,
  listedInPlaylists: true,
  coverImageId: null,
  mosaicCoverImageIds: [],
  soleMemberTrackCount: 0,
  containsTrack: null,
  sharedAt: null,
  pinnedAt: null,
  createdAt: '2026-07-23T10:00:00.000Z',
  updatedAt: '2026-07-23T10:00:00.000Z',
};

function renderGrid(curatedPlaylists: PlaylistSummaryItem[]): string {
  return renderToStaticMarkup(
    React.createElement(PlaylistsGridContent, {
      curatedPlaylists,
      onCreate: () => undefined,
      actions: {
        onPlay: () => undefined,
        onAddTracks: () => undefined,
        onManageCover: () => undefined,
        onRename: () => undefined,
        onDelete: () => undefined,
        onShare: () => undefined,
        onTogglePin: () => undefined,
      },
    }),
  );
}

describe('Playlists grid', () => {
  beforeAll(() => vi.stubGlobal('React', React));
  afterAll(() => vi.unstubAllGlobals());

  it('shows New playlist first and omits the Favorites and Saved collections', () => {
    const playlists: PlaylistSummaryItem[] = [
      {
        ...basePlaylist,
        id: 'favorites-id',
        name: 'Favorites',
        kind: 'favorites',
        listedInPlaylists: false,
      },
      {
        ...basePlaylist,
        id: 'saved-id',
        name: 'Saved tracks',
        listedInPlaylists: false,
      },
      { ...basePlaylist, id: 'saved-user-id', name: 'Saved tracks' },
      { ...basePlaylist, id: 'playlist-id', name: 'Focus' },
    ];
    // The grid renders the caller's curated projection (the one shared with the
    // tab count); the curation rule itself lives in the view model.
    const markup = renderGrid(playlists.filter(isCuratedPlaylist));

    expect(
      [...markup.matchAll(/data-testid="(new-playlist-tile|playlist-card-[^"]+)"/g)].map(
        (match) => match[1],
      ),
    ).toEqual(['new-playlist-tile', 'playlist-card-saved-user-id', 'playlist-card-playlist-id']);

    expect(
      [...markup.matchAll(/data-testid="playlist-menu-([^"]+)"/g)].map((match) => match[1]),
    ).toEqual(['saved-user-id', 'playlist-id']);
  });

  it('tells each playlist by size and freshness, and offers play from the cover', () => {
    const markup = renderGrid([
      {
        ...basePlaylist,
        id: 'focus-id',
        name: 'Focus',
        trackCount: 14,
        totalDurationSeconds: 3120,
      },
    ]);

    expect(markup).toContain('14 Tracks · 52 min');
    expect(markup).toMatch(/Edited .+ ago/);
    expect(markup).toContain('aria-label="Play Focus"');
  });

  it('marks a Library-pinned card on its cover, and only that card', () => {
    const markup = renderGrid([
      { ...basePlaylist, id: 'pinned-id', name: 'Pinned', pinnedAt: '2026-07-23T11:00:00.000Z' },
      { ...basePlaylist, id: 'plain-id', name: 'Plain' },
    ]);

    expect(markup).toContain('data-testid="playlist-pinned-pinned-id"');
    expect(markup).not.toContain('data-testid="playlist-pinned-plain-id"');
  });

  it('serves full-card covers at full resolution while mosaic tiles keep thumbnails', () => {
    const markup = renderGrid([
      { ...basePlaylist, id: 'custom-id', name: 'Custom cover', coverImageId: 'custom-cover' },
      {
        ...basePlaylist,
        id: 'mosaic-id',
        name: 'Mosaic',
        mosaicCoverImageIds: ['tile-a', 'tile-b', 'tile-c', 'tile-d'],
      },
    ]);

    const requests = coverRequests(markup);
    expect(requests).toContain('/api/covers/custom-cover');
    for (const tile of ['tile-a', 'tile-b', 'tile-c', 'tile-d']) {
      expect(requests).toContain(`/api/covers/${tile}?w=160`);
    }
  });
});
