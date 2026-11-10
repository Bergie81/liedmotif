'use client';

// The Playlist detail surface's member state: the summary, the loaded prefix of
// members, and every rule that keeps the two coherent under paging and
// optimistic curation. The loaded list is always a dense prefix of the server
// order — pages extend it, removals reindex it — so `hasMore` derives from the
// live `trackCount` and the next cursor from the last loaded position; no
// stored cursor exists to go stale when the server resequences.

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { PlaylistMemberItem, PlaylistSummaryItem } from '@liedmotif/shared';
import {
  getAllPlaylistMembers,
  getPlaylist,
  removePlaylistTrack,
  type PlaylistPageFetcher,
} from '@/lib/api-client';
import { appendUniqueById } from '@/lib/append-unique';
import { useOutsideLibraryWrite } from '@/components/library/use-outside-library-write';
import { usePageEpoch } from '@/components/use-page-epoch';
import { useServerSeed } from '@/components/use-server-seed';
import {
  hasUnloadedMembers,
  nextMemberCursor,
  PLAYLIST_DETAIL_PAGE_LIMIT,
  reindexMembers,
} from './playlist-view-model';

/** A playlist summary with an ordered member list (full or a loaded prefix). */
export interface PlaylistMembership {
  playlist: PlaylistSummaryItem;
  items: PlaylistMemberItem[];
}

export function usePlaylistMembers({
  playlistId,
  initial,
  fetchPage,
  onError,
  onUnsaved,
}: {
  playlistId: string;
  /** Server-rendered summary + first member page: skips the mount fetch. */
  initial?: PlaylistMembership;
  /** Where a page comes from — the owner's detail endpoint unless a surface
   *  reads elsewhere (the Lounge visitor view). Must be referentially stable. */
  fetchPage?: PlaylistPageFetcher;
  /** Curation/paging failures (the caller's action banner). */
  onError: (message: string) => void;
  /** A removal took the track's LAST membership (the caller's Library-exit notice). */
  onUnsaved: () => void;
}) {
  const router = useRouter();
  const [playlist, setPlaylist] = useState<PlaylistSummaryItem | null>(initial?.playlist ?? null);
  const [items, setItems] = useState<PlaylistMemberItem[] | null>(initial?.items ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // A full-membership fetch is in flight (Play / reorder / Add Tracks).
  const [loadingAll, setLoadingAll] = useState(false);
  // Optimistic removals still committing server-side: a member page fetched in
  // that window reads pre-resequence positions and would resurrect the removed
  // row, so paging holds until the count drains.
  const [pendingRemoves, setPendingRemoves] = useState(0);
  const consumeServerSeed = useServerSeed(initial != null);
  const { loadingMore, invalidate, beginFirstPage, beginNextPage, settle } = usePageEpoch();

  const fetchMemberPage = useCallback<PlaylistPageFetcher>(
    (cursor, limit) =>
      fetchPage ? fetchPage(cursor, limit) : getPlaylist(playlistId, cursor, limit),
    [fetchPage, playlistId],
  );

  const load = useCallback(async () => {
    const token = beginFirstPage();
    const result = await fetchMemberPage(null, PLAYLIST_DETAIL_PAGE_LIMIT);
    if (!settle(token)) return;
    if (!result.ok) {
      setLoadError(
        result.error.code === 'not_found'
          ? 'This playlist does not exist.'
          : `Couldn’t load the playlist: ${result.error.message}`,
      );
      return;
    }
    setPlaylist(result.data.playlist);
    setItems(result.data.items);
  }, [fetchMemberPage, beginFirstPage, settle]);

  useEffect(() => {
    if (consumeServerSeed()) return;
    void load();
  }, [load, consumeServerSeed]);
  useOutsideLibraryWrite(() => void load());

  const hasMore =
    playlist !== null && items !== null && hasUnloadedMembers(items, playlist.trackCount);
  const removing = pendingRemoves > 0;

  async function loadMore() {
    if (!items || !hasMore || loadingMore || loadingAll || removing) return;
    const cursor = nextMemberCursor(items);
    if (!cursor) return;
    const token = beginNextPage();
    if (token === null) return;
    const result = await fetchMemberPage(cursor, PLAYLIST_DETAIL_PAGE_LIMIT);
    if (!settle(token)) return;
    if (!result.ok) {
      onError(`Couldn’t load more Tracks: ${result.error.message}`);
      return;
    }
    setPlaylist(result.data.playlist);
    setItems((current) => appendUniqueById(current ?? [], result.data.items));
  }

  /**
   * The loaded membership when it is already complete, otherwise the full
   * membership fetched now — Play, reorder and Add Tracks act on the WHOLE
   * playlist, never on the loaded prefix. Answers with the fetched data (never
   * a stale closure) and null when the fetch failed.
   */
  async function ensureAllMembers(): Promise<PlaylistMembership | null> {
    if (!playlist || !items) return null;
    if (!hasMore) return { playlist, items };
    const token = invalidate();
    setLoadingAll(true);
    const result = await getAllPlaylistMembers(playlistId, fetchMemberPage);
    setLoadingAll(false);
    if (!result.ok) {
      onError(`Couldn’t load the playlist: ${result.error.message}`);
      return null;
    }
    if (settle(token)) {
      setPlaylist(result.data.playlist);
      setItems(result.data.items);
    }
    return { playlist: result.data.playlist, items: result.data.items };
  }

  /** Move one member's facts out of (or back into) the summary the header shows. */
  function shiftSummary(item: PlaylistMemberItem, op: 'remove' | 'restore') {
    const sign = op === 'remove' ? -1 : 1;
    setPlaylist((p) =>
      p
        ? {
            ...p,
            trackCount: p.trackCount + sign,
            totalDurationSeconds: p.totalDurationSeconds + sign * (item.durationSeconds ?? 0),
            downloadableTrackCount: p.downloadableTrackCount + (item.downloadable ? sign : 0),
          }
        : p,
    );
  }

  /** Take a member out of the local state (the server already lost it, or is about to). */
  function dropMember(item: PlaylistMemberItem) {
    setItems((current) =>
      current ? reindexMembers(current.filter((member) => member.id !== item.id)) : current,
    );
    shiftSummary(item, 'remove');
  }

  /** Optimistic membership removal with rollback; the server resequences densely. */
  function removeMember(trackId: string) {
    const member = items?.find((item) => item.id === trackId);
    if (!items || !member) return;
    const previous = items;
    dropMember(member);
    setPendingRemoves((count) => count + 1);
    void removePlaylistTrack(playlistId, trackId).then((result) => {
      setPendingRemoves((count) => count - 1);
      if (!result.ok) {
        setItems(previous);
        shiftSummary(member, 'restore');
        onError(`Remove failed: ${result.error.message}`);
        return;
      }
      router.refresh();
      if (result.data.unsaved) onUnsaved();
    });
  }

  return {
    playlist,
    setPlaylist,
    items,
    setItems,
    loadError,
    hasMore,
    loadingMore,
    loadingAll,
    removing,
    load,
    loadMore,
    ensureAllMembers,
    removeMember,
    dropMember,
  };
}
