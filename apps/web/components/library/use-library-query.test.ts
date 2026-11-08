// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureFetches } from '@/tests/helpers/capture-fetches';
import { useLibraryQuery } from './use-library-query';

function libraryTrack(id: string) {
  return {
    id,
    title: 'Track',
    generatedArtistName: null,
    status: 'ready',
    durationSeconds: 180,
    coverImageId: null,
    audioUrl: `/api/audio/${id}`,
    savedAt: '2026-07-24T10:00:00.000Z',
    favoritedAt: null,
    inCuratedPlaylist: false,
    dislikedAt: null,
    genreTags: [],
    vocalMode: 'instrumental',
    hasLyrics: false,
    downloadable: true,
    createdAt: '2026-07-24T10:00:00.000Z',
    hasPlayed: false,
    originSessionId: '223e4567-e89b-12d3-a456-426614174000',
    originSessionTitle: 'Focus',
  };
}

function libraryPage(
  view: 'saved' | 'history',
  nextCursor: string | null,
  items: ReturnType<typeof libraryTrack>[] = [],
) {
  return {
    ok: true,
    data: {
      view,
      items,
      nextCursor,
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useLibraryQuery', () => {
  it('allows pagination after a search supersedes an in-flight page', async () => {
    const requests = captureFetches();
    const { result, rerender } = renderHook(
      ({ search }: { search: string }) => useLibraryQuery('history', search),
      { initialProps: { search: 'old' } },
    );

    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => requests[0]!.respond(libraryPage('history', 'old-page-2')));
    await waitFor(() => expect(result.current.nextCursor).toBe('old-page-2'));

    let stalePage: Promise<void> | undefined;
    act(() => {
      stalePage = result.current.loadMore();
    });
    await waitFor(() => expect(requests).toHaveLength(2));

    rerender({ search: 'new' });
    await waitFor(() => expect(requests).toHaveLength(3));
    await act(async () => requests[2]!.respond(libraryPage('history', 'new-page-2')));
    await act(async () => {
      requests[1]!.respond(libraryPage('history', null));
      await stalePage;
    });

    expect(result.current.loadingMore).toBe(false);
  });

  it('never pages a new search with the previous search’s cursor', async () => {
    const requests = captureFetches();
    const { result, rerender } = renderHook(
      ({ search }: { search: string }) => useLibraryQuery('history', search),
      { initialProps: { search: '' } },
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => requests[0]!.respond(libraryPage('history', 'all-page-2')));
    await waitFor(() => expect(result.current.nextCursor).toBe('all-page-2'));

    rerender({ search: 'rain' });
    await waitFor(() => expect(requests).toHaveLength(2));
    // Load more while the new search's first page is still out: no cursor of
    // the list being replaced may page the new query.
    act(() => {
      void result.current.loadMore();
    });
    expect(requests).toHaveLength(2);

    await act(async () => requests[1]!.respond(libraryPage('history', 'rain-page-2')));
    await waitFor(() => expect(result.current.nextCursor).toBe('rain-page-2'));
    act(() => {
      void result.current.loadMore();
    });
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]!.path).toContain('cursor=rain-page-2');
  });

  it('aborts a superseded first-page request on the next keystroke', async () => {
    const requests = captureFetches();
    const { rerender, unmount } = renderHook(
      ({ search }: { search: string }) => useLibraryQuery('history', search),
      { initialProps: { search: 'ra' } },
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.signal?.aborted).toBe(false);

    rerender({ search: 'rainy' });
    await waitFor(() => expect(requests).toHaveLength(2));
    // The keystroke-superseded page is cancelled, not downloaded and discarded.
    expect(requests[0]!.signal?.aborted).toBe(true);
    expect(requests[1]!.signal?.aborted).toBe(false);

    unmount();
    expect(requests[1]!.signal?.aborted).toBe(true);
  });

  it('does not append an in-flight page after the Library view changes', async () => {
    const requests = captureFetches();
    const { result, rerender } = renderHook(
      ({ view }: { view: 'saved' | 'history' }) => useLibraryQuery(view),
      { initialProps: { view: 'history' } as { view: 'saved' | 'history' } },
    );

    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => requests[0]!.respond(libraryPage('history', 'history-page-2')));
    await waitFor(() => expect(result.current.nextCursor).toBe('history-page-2'));

    let stalePage: Promise<void> | undefined;
    act(() => {
      stalePage = result.current.loadMore();
    });
    await waitFor(() => expect(requests).toHaveLength(2));

    rerender({ view: 'saved' });
    await waitFor(() => expect(requests).toHaveLength(3));
    const savedTrack = libraryTrack('00000000-0000-4000-8000-000000000001');
    await act(async () => requests[2]!.respond(libraryPage('saved', null, [savedTrack])));
    await act(async () => {
      const historyTrack = libraryTrack('00000000-0000-4000-8000-000000000002');
      requests[1]!.respond(libraryPage('history', null, [historyTrack]));
      await stalePage;
    });

    expect(result.current.items?.map((track) => track.id)).toEqual([savedTrack.id]);
  });

  it('carries curated membership onto the row a picker commit settled', async () => {
    const requests = captureFetches();
    const { result } = renderHook(() => useLibraryQuery('history'));
    await waitFor(() => expect(requests).toHaveLength(1));
    const track = libraryTrack('00000000-0000-4000-8000-000000000001');
    await act(async () => requests[0]!.respond(libraryPage('history', null, [track])));
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    act(() => {
      result.current.applyTrackFlags(
        track.id,
        {
          trackId: track.id,
          savedAt: track.savedAt,
          favoritedAt: null,
          dislikedAt: null,
          retentionClass: 'durable',
        },
        true,
        false,
      );
    });

    // The picker is the only writer of this fact, so dropping it here leaves the
    // row's Add to Playlist reporting the pre-commit state until the next fetch.
    expect(result.current.items?.[0]?.inCuratedPlaylist).toBe(true);
  });
});
