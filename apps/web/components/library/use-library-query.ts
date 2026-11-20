'use client';

import { useEffect, useState } from 'react';
import type { LibraryTrackItem, LibraryView, TrackFlags } from '@liedmotif/shared';
import { getLibrary } from '@/lib/http/api-client';
import { appendUniqueById } from '@/lib/append-unique';
import { toast } from '@/lib/toast';
import { usePageEpoch } from '@/components/use-page-epoch';
import { withSettledRetention } from './library-view-model';
import { useOutsideLibraryWrite } from './use-outside-library-write';

/** The Library tabs that list Tracks. Favorites is a Playlist, reached from the
 *  Playlists grid, so its API view has no tab of its own. */
export type LibraryTrackTab = Exclude<LibraryView, 'favorites'>;
export type LibraryTab = LibraryTrackTab | 'playlists';

const LOAD_MORE_KEY = 'library-load-more';

export function useLibraryQuery(view: LibraryView, search = '') {
  const [items, setItems] = useState<LibraryTrackItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { loadingMore, invalidate, beginFirstPage, beginNextPage, settle } = usePageEpoch();
  // Counts the writes the list cannot patch (made from outside the page, or
  // answered without flags): each one is a reason to read the first page
  // again, like a change of the query.
  const [outsideWrites, setOutsideWrites] = useState(0);
  useOutsideLibraryWrite(() => setOutsideWrites((count) => count + 1));

  useEffect(() => {
    // A query change supersedes every in-flight fetch; the fresh first page
    // owns the list. The superseded request is aborted outright — a keystroke
    // burst must not download pages the epoch token would discard anyway.
    const token = beginFirstPage();
    setError(null);
    const controller = new AbortController();
    void getLibrary(view, { search, signal: controller.signal }).then((result) => {
      if (controller.signal.aborted || !settle(token, result.ok)) return;
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
  }, [view, search, outsideWrites, invalidate, beginFirstPage, settle]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const token = beginNextPage();
    if (token === null) return;
    toast.dismiss(LOAD_MORE_KEY);
    const result = await getLibrary(view, { cursor: nextCursor, search });
    if (!settle(token)) return;
    if (result.ok) {
      setItems((current) => appendUniqueById(current ?? [], result.data.items));
      setNextCursor(result.data.nextCursor);
    } else {
      toast.error(`Couldn’t load more tracks: ${result.error.message}`, { key: LOAD_MORE_KEY });
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

  /** Read the first page again after a write whose response carries no flags to patch with. */
  function reload() {
    setOutsideWrites((count) => count + 1);
  }

  return { items, nextCursor, error, loadingMore, loadMore, applyTrackFlags, removeTrack, reload };
}
