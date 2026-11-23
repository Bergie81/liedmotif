// @vitest-environment jsdom

// A search that found no exact words answers with the closest names (or, in
// Lyrics search, the closest lyric lines). The summary line says so instead of
// counting "results", the sort selector stays away so the closest row remains
// first, and a screen reader hears the label with the results.

import { createElement as h } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SearchPlaylistItem, SearchResponseData } from '@liedmotif/shared';
import { SearchResults, SearchSummaryRow } from './search-results';
import type { SearchQueryState } from './use-search-query';

afterEach(cleanup);

function lyricsResponse(query: string, closeMatches: boolean, matchCount: number) {
  return {
    query,
    scope: 'all',
    sort: 'title',
    lyrics: true,
    closeMatches,
    sessions: null,
    tracks: { items: [], matchCount, truncated: false },
    playlists: null,
  } as SearchResponseData;
}

function closeNamesResponse(query: string, playlists: SearchPlaylistItem[]) {
  const group = <T>(items: T[]) => ({ items, matchCount: items.length, truncated: false });
  return {
    query,
    scope: 'all',
    sort: 'title',
    lyrics: false,
    closeMatches: true,
    sessions: group([]),
    tracks: group([]),
    playlists: group(playlists),
  } as SearchResponseData;
}

function focusAndFlow(): SearchPlaylistItem {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Focus & Flow',
    kind: 'user',
    listedInPlaylists: true,
    trackCount: 12,
    totalDurationSeconds: 2400,
    downloadableTrackCount: 12,
    coverImageId: null,
    mosaicCoverImageIds: [],
    soleMemberTrackCount: 0,
    soleMemberDeletedTrackCount: 0,
    containsTrack: null,
    sharedAt: null,
    pinnedAt: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    matchContext: { field: 'name', snippet: 'Focus & Flow' },
    memberMatchCount: 0,
    owner: null,
  };
}

function renderSummary(data: SearchResponseData) {
  return render(h(SearchSummaryRow, { data, sort: 'title', onSortChange: () => {} }));
}

describe('the Search summary line', () => {
  it('labels close matches instead of counting results, without a sort selector', () => {
    const { container } = renderSummary(lyricsResponse('zu viert auf dem mnod', true, 3));

    expect(container.textContent).toBe(
      'No exact match for “zu viert auf dem mnod”. Closest lyrics:',
    );
    expect(screen.queryByRole('button', { name: /sort search results/i })).toBeNull();
  });

  it('labels close name matches the same way, without a sort selector', () => {
    const { container } = renderSummary(closeNamesResponse('Rainy Sunday Joz', []));

    expect(container.textContent).toBe('No exact match for “Rainy Sunday Joz”. Closest names:');
    expect(screen.queryByRole('button', { name: /sort search results/i })).toBeNull();
  });

  it('counts exact results and offers the sort selector', () => {
    const { container } = renderSummary(lyricsResponse('zu viert auf dem Mond', false, 1));

    expect(container.textContent).toContain('1 result for “zu viert auf dem Mond”');
    expect(screen.getByRole('button', { name: 'Sort Search Results: Title A–Z' })).toBeTruthy();
  });
});

describe('the Search results region', () => {
  const noCounts = { sessions: null, tracks: null, playlists: null };

  function results(data: SearchResponseData | null): SearchQueryState {
    return { data, loading: data === null, error: null, counts: noCounts };
  }

  function view(data: SearchResponseData | null) {
    return h(SearchResults, {
      state: { query: 'zu viert auf dem mnod', scope: 'all', sort: 'title', lyrics: true },
      results: results(data),
      onScopeChange: () => {},
      onSortChange: () => {},
      onEngage: () => {},
      onTrackRemoved: () => {},
    });
  }

  it('announces the close-match label in a live region that outlives loading and the Lyrics toggle', () => {
    const { container, rerender } = render(view(null));
    const region = container.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();

    rerender(
      view({
        ...lyricsResponse('zu viert auf dem mnod', false, 0),
        lyrics: false,
        sessions: { items: [], matchCount: 0, truncated: false },
        playlists: { items: [], matchCount: 0, truncated: false },
      }),
    );
    expect(container.querySelector('[aria-live="polite"]')).toBe(region);

    rerender(view(lyricsResponse('zu viert auf dem mnod', true, 0)));
    expect(container.querySelector('[aria-live="polite"]')).toBe(region);
    expect(region!.textContent).toContain('No exact match for “zu viert auf dem mnod”.');
  });

  it('shows close name groups under All without a See all action or a member-match line', () => {
    const playlist = focusAndFlow();
    render(
      h(SearchResults, {
        state: { query: 'Fokus und Flow', scope: 'all', sort: 'title', lyrics: false },
        results: results(closeNamesResponse('Fokus und Flow', [playlist])),
        onScopeChange: () => {},
        onSortChange: () => {},
        onEngage: () => {},
        onTrackRemoved: () => {},
      }),
    );

    expect(screen.getByText(/Closest names:/)).toBeTruthy();
    const row = screen.getByRole('link', { name: /Focus & Flow/ });
    expect(row.textContent).toContain('12 TRACKS');
    expect(row.textContent).not.toMatch(/MATCH/);
    expect(screen.queryByRole('button', { name: /^Show / })).toBeNull();
    expect(screen.queryByRole('heading', { name: /Sessions|Tracks/ })).toBeNull();
    expect(screen.getByRole('heading', { name: /Playlists/ }).textContent).not.toMatch(/match/i);
  });

  it('still offers to start a Session from the words when only close names answer', () => {
    render(
      h(SearchResults, {
        state: { query: 'rainy night lo-fi', scope: 'all', sort: 'title', lyrics: false },
        results: results(closeNamesResponse('rainy night lo-fi', [focusAndFlow()])),
        onScopeChange: () => {},
        onSortChange: () => {},
        onEngage: () => {},
        onTrackRemoved: () => {},
      }),
    );

    expect(
      screen.getByRole('link', { name: /Start a Session from “rainy night lo-fi”/ }),
    ).toBeTruthy();
  });
});
