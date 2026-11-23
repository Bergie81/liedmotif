// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureFetches } from '@/tests/helpers/capture-fetches';
import { announceOutsideLibraryWrite } from '@/lib/offline/library-writes';
import { createInitialSearchState, type SearchState } from './search-model';
import { useSearchQuery } from './use-search-query';

function emptyGroup() {
  return { items: [], matchCount: 0, truncated: false };
}

function searchResponse(query: string, trackCount: number) {
  return {
    ok: true,
    data: {
      query,
      scope: 'all',
      sort: 'relevance',
      lyrics: false,
      closeMatches: false,
      sessions: emptyGroup(),
      tracks: { items: [], matchCount: trackCount, truncated: false },
      playlists: emptyGroup(),
    },
  };
}

function state(overrides: Partial<SearchState>): SearchState {
  return { ...createInitialSearchState(), ...overrides };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useSearchQuery', () => {
  it('runs nothing below the minimum query length', () => {
    const requests = captureFetches();
    renderHook(() => useSearchQuery(state({ query: 'x' })));
    expect(requests).toHaveLength(0);
  });

  it('fetches on a runnable query and keeps previous results while reloading', async () => {
    const requests = captureFetches();
    const { result, rerender } = renderHook(({ s }) => useSearchQuery(s), {
      initialProps: { s: state({ query: 'rain' }) },
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => requests[0]!.respond(searchResponse('rain', 3)));
    expect(result.current.data?.tracks?.matchCount).toBe(3);

    rerender({ s: state({ query: 'rain', sort: 'title' }) });
    await waitFor(() => expect(requests).toHaveLength(2));
    // The previous results stay visible while the re-sort is in flight.
    expect(result.current.loading).toBe(true);
    expect(result.current.data?.tracks?.matchCount).toBe(3);
  });

  it('discards a stale response: the last thing typed always wins', async () => {
    const requests = captureFetches();
    const { result, rerender } = renderHook(({ s }) => useSearchQuery(s), {
      initialProps: { s: state({ query: 'ra' }) },
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    rerender({ s: state({ query: 'rainy' }) });
    await waitFor(() => expect(requests).toHaveLength(2));

    // The newer query resolves FIRST; the older one after — and must not win.
    await act(async () => requests[1]!.respond(searchResponse('rainy', 7)));
    await act(async () => requests[0]!.respond(searchResponse('ra', 99)));
    expect(result.current.data?.query).toBe('rainy');
    expect(result.current.data?.tracks?.matchCount).toBe(7);
    expect(result.current.loading).toBe(false);
  });

  it('aborts the superseded request instead of downloading its payload', async () => {
    const requests = captureFetches();
    const { unmount, rerender } = renderHook(({ s }) => useSearchQuery(s), {
      initialProps: { s: state({ query: 'ra' }) },
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.signal?.aborted).toBe(false);

    // The next keystroke supersedes the in-flight request — it is cancelled
    // outright, not just discarded after a full download.
    rerender({ s: state({ query: 'rainy' }) });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]!.signal?.aborted).toBe(true);
    expect(requests[1]!.signal?.aborted).toBe(false);

    unmount();
    expect(requests[1]!.signal?.aborted).toBe(true);
  });

  it('resets to rest when the query drops below the minimum', async () => {
    const requests = captureFetches();
    const { result, rerender } = renderHook(({ s }) => useSearchQuery(s), {
      initialProps: { s: state({ query: 'rain' }) },
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => requests[0]!.respond(searchResponse('rain', 3)));

    rerender({ s: state({ query: '' }) });
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('keeps last-known group counts across a scope change but not a query change', async () => {
    const requests = captureFetches();
    const { result, rerender } = renderHook(({ s }) => useSearchQuery(s), {
      initialProps: { s: state({ query: 'rain' }) },
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => requests[0]!.respond(searchResponse('rain', 3)));
    expect(result.current.counts).toEqual({ sessions: 0, tracks: 3, playlists: 0 });

    // A scoped response counts only its own group; the others keep their counts.
    rerender({ s: state({ query: 'rain', scope: 'tracks' }) });
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () =>
      requests[1]!.respond({
        ok: true,
        data: {
          query: 'rain',
          scope: 'tracks',
          sort: 'relevance',
          lyrics: false,
          closeMatches: false,
          sessions: null,
          tracks: { items: [], matchCount: 3, truncated: false },
          playlists: null,
        },
      }),
    );
    expect(result.current.counts).toEqual({ sessions: 0, tracks: 3, playlists: 0 });

    // New words: every remembered count is for a different search.
    rerender({ s: state({ query: 'sunny', scope: 'tracks' }) });
    await waitFor(() =>
      expect(result.current.counts).toEqual({ sessions: null, tracks: null, playlists: null }),
    );
  });

  it('lyrics mode requests ?lyrics=1 immediately and drops the stale group counts', async () => {
    const requests = captureFetches();
    const { result, rerender } = renderHook(({ s }) => useSearchQuery(s), {
      initialProps: { s: state({ query: 'rain' }) },
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => requests[0]!.respond(searchResponse('rain', 3)));
    expect(result.current.counts.sessions).toBe(0);

    rerender({ s: state({ query: 'rain', lyrics: true }) });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]!.path).toBe('/api/search?q=rain&scope=all&sort=relevance&lyrics=1');
    // Sessions and Playlists cannot match under the lyrics lens — no stale
    // count may survive onto a collapsed tab.
    expect(result.current.counts).toEqual({ sessions: null, tracks: null, playlists: null });
  });

  it('reads the same search again after the Library was written to from outside the page', async () => {
    const requests = captureFetches();
    const { result } = renderHook(() => useSearchQuery(state({ query: 'rain' })));
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => requests[0]!.respond(searchResponse('rain', 3)));

    act(() => announceOutsideLibraryWrite());

    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]!.path).toBe(requests[0]!.path);
    await act(async () => requests[1]!.respond(searchResponse('rain', 4)));
    expect(result.current.data?.tracks?.matchCount).toBe(4);
  });
});
