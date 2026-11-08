'use client';

import { useEffect, useState } from 'react';
import type { LibraryTrackItem, LibraryView, TrackFlags } from '@liedmotif/shared';
import { getLibrary } from '@/lib/api-client';
import { appendUniqueById } from '@/lib/append-unique';
import { usePageEpoch } from '@/components/use-page-epoch';
import { withSettledRetention } from './library-view-model';

export type LibraryTab = LibraryView | 'playlists';

export function useLibraryQuery(view: LibraryView, search = '') {
  const [items, setItems] = useState<LibraryTrackItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { loadingMore, invalidate, beginFirstPage, beginNextPage, settle } = usePageEpoch();

  useEffect(() => {
    // A query change supersedes every in-flight fetch; the fresh first page
    // owns the list. The superseded request is aborted outright — a keystroke
    // burst must not download pages the epoch token would discard anyway.
    const token = beginFirstPage();
    setError(null);
    const controller = new AbortController();
    void getLibrary(view, { search, signal: controller.signal }).then((result) => {
      if (controller.signal.aborted || !settle(token)) return;
      if (result.ok) {
        setItems(result.data.items);
        setNextCursor(result.data.nextCursor);
      } else {
        setError(result.error.message);
      }
    });
    return () => {
      controller.abort();
      invalidate();
    };
  }, [view, search, invalidate, beginFirstPage, settle]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const token = beginNextPage();
    if (token === null) return;
    setError(null);
    const result = await getLibrary(view, { cursor: nextCursor, search });
    if (!settle(token)) return;
    if (result.ok) {
      setItems((current) => appendUniqueById(current ?? [], result.data.items));
      setNextCursor(result.data.nextCursor);
    } else {
      setError(result.error.message);
    }
  }

  function applyTrackFlags(
    trackId: string,
    flags: TrackFlags,
    inCuratedPlaylist: boolean,
    remove: boolean,
  ) {
    setItems((current) => {
      if (!current) return current;
      if (remove) return current.filter((track) => track.id !== trackId);
      return current.map((track) =>
        track.id === trackId ? withSettledRetention(track, flags, inCuratedPlaylist) : track,
      );
    });
  }

  /** Drop a row outright (the track was deleted, not re-flagged). */
  function removeTrack(trackId: string) {
    setItems((current) => (current ? current.filter((track) => track.id !== trackId) : current));
  }

  return { items, nextCursor, error, loadingMore, loadMore, applyTrackFlags, removeTrack };
}
