'use client';

import { useEffect, useRef, useState } from 'react';
import type { LibraryTrackItem, LibraryView, TrackFlags } from '@liedmotif/shared';
import { deleteTrack as deleteTrackApi, favoriteTrack, unsaveTrack } from '@/lib/api-client';
import { useSeedMoreLikeThis } from '@/components/sessions/use-seed-more-like-this';

export type LibraryActionName = 'save' | 'favorite' | 'seed' | 'delete';
export type BusyAction = { trackId: string; action: LibraryActionName } | null;

export function useLibraryActions({
  view,
  onFlagsResolved,
  onTrackRemoved,
}: {
  view: LibraryView;
  /** `inCuratedPlaylist` rides alongside the flags because no flag implies it:
   *  only the save picker moves it, so every caller states what it knows. */
  onFlagsResolved: (
    trackId: string,
    flags: TrackFlags,
    inCuratedPlaylist: boolean,
    remove: boolean,
  ) => void;
  /** The track is GONE (deleted), not merely re-flagged — drop its row. */
  onTrackRemoved: (trackId: string) => void;
}) {
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const seed = useSeedMoreLikeThis();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function begin(trackId: string, action: LibraryActionName) {
    setBusyAction({ trackId, action });
    setActionError(null);
  }

  /** Unsave everywhere (retention is membership — removes every playlist
   *  membership). Saving goes through the playlist picker instead. */
  async function unsave(track: LibraryTrackItem) {
    begin(track.id, 'save');
    const result = await unsaveTrack(track.id);
    if (!mountedRef.current) return;
    setBusyAction(null);
    if (!result.ok) {
      setActionError(`Save change failed: ${result.error.message}`);
      return;
    }
    const remove = view === 'saved' || (view === 'favorites' && !result.data.favoritedAt);
    // Unsave leaves EVERY playlist, so no curated membership survives it.
    onFlagsResolved(track.id, result.data, false, remove);
  }

  /** Reflect a settled save-picker commit (the picker owns the write). */
  function applyPickerFlags(trackId: string, flags: TrackFlags, inCuratedPlaylist: boolean) {
    const remove =
      (view === 'saved' && !flags.savedAt) || (view === 'favorites' && !flags.favoritedAt);
    onFlagsResolved(trackId, flags, inCuratedPlaylist, remove);
  }

  async function toggleFavorite(track: LibraryTrackItem) {
    const favorited = !track.favoritedAt;
    begin(track.id, 'favorite');
    const result = await favoriteTrack(track.id, favorited);
    if (!mountedRef.current) return;
    setBusyAction(null);
    if (!result.ok) {
      setActionError(`Favorite change failed: ${result.error.message}`);
      return;
    }
    // The star moves the Save floor, never Playlist membership. Unstarring a
    // Track kept only by Favorites unsaves it, so it leaves Saved too.
    onFlagsResolved(
      track.id,
      result.data,
      track.inCuratedPlaylist,
      (view === 'favorites' && !result.data.favoritedAt) ||
        (view === 'saved' && !result.data.savedAt),
    );
  }

  /** Permanent owner delete (never feedback). The row leaves EVERY view — a
   *  deleted track has no audio and no listing. True on success. */
  async function deleteTrack(track: LibraryTrackItem): Promise<boolean> {
    begin(track.id, 'delete');
    const result = await deleteTrackApi(track.id);
    if (!mountedRef.current) return false;
    setBusyAction(null);
    if (!result.ok) {
      setActionError(`Delete failed: ${result.error.message}`);
      return false;
    }
    onTrackRemoved(track.id);
    return true;
  }

  async function seedMoreLikeThis(track: LibraryTrackItem) {
    begin(track.id, 'seed');
    const failure = await seed([track.id]);
    if (!mountedRef.current) return;
    setBusyAction(null);
    if (failure) setActionError(failure);
  }

  return {
    busyAction,
    actionError,
    clearActionError: () => setActionError(null),
    reportActionError: setActionError,
    unsave,
    applyPickerFlags,
    toggleFavorite,
    seedMoreLikeThis,
    deleteTrack,
  };
}
