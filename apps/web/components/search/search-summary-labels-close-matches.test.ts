// @vitest-environment jsdom

// A Lyrics search that found no exact words answers with the closest lyric
// lines. The summary line says so instead of counting "results", and the sort
// selector stays away so the closest Track remains first, and a screen reader
// hears the label with the results.

import { createElement as h } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SearchResponseData } from '@liedmotif/shared';
import { SearchResults, SearchSummaryRow } from './search-results';
import type { SearchQueryState } from './use-search-query';

afterEach(cleanup);

function lyricsResponse(query: string, closeMatches: boolean, matchCount: number) {
  return {
    query,
    scope: 'all',
    sort: 'title',
    lyrics: true,
    sessions: null,
    tracks: { items: [], matchCount, truncated: false, closeMatches },
    playlists: null,
  } as SearchResponseData;
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
});
