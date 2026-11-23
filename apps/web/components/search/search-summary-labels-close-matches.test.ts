// @vitest-environment jsdom

// A Lyrics search that found no exact words answers with the closest lyric
// lines. The summary line says so instead of counting "results", and the sort
// selector stays away so the closest Track remains first.

import { createElement as h } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SearchResponseData } from '@liedmotif/shared';
import { SearchSummaryRow } from './search-results';

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
