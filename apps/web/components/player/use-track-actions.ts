'use client';

// Current-Track mutations split from the playback controller: feedback,
// retention, and explicit deletion share optimistic UI plumbing while their
// domain effects remain separate. The controller supplies queue/cursor effects
// through narrow ports; a write that did not land is an error toast.

import { useCallback, useRef } from 'react';
import {
  deleteTrack as deleteTrackRequest,
  dislikeTrack,
  favoriteTrack,
  sendFeedback,
} from '@/lib/http/api-client';
import type { PlayableTrack } from './playable-track';
import { clearPlayerError, showPlayerError, type PlayerAct } from './player-error-toast';
import {
  optimisticFavoriteFlags,
  type RetentionAdded,
  settleTrackFlags,
  type TrackRetentionFlags,
  withRetentionAdded,
} from './track-retention';

export interface TrackActionDeps {
  /** The engaged source's id, which keys its failure toasts. */
  sourceId: string;
  /** Null for a Playlist source: Skip is plain navigation, no feedback event. */
  sessionId: string | null;
  activeTrack(): PlayableTrack | null;
  /** Patch the render state for retention controls. */
  patch(next: { currentFavorited: boolean; currentInCuratedPlaylist: boolean }): void;
  /** Local removal bookkeeping (a stale poll must not resurrect the track). */
  markRemoved(queueItemId: string): void;
  unmarkRemoved(queueItemId: string): void;
  /** Drop the item from the live queue projection immediately. */
  removeFromQueue(queueItemId: string): void;
  /** Move on after a removal according to the selected playback mode. */
  advancePastCurrent(): void;
  /** The server-side Queue changed (e.g. a Dislike's reroll): observe it now
   * instead of waiting out the current poll delay. */
  queueChanged(): void;
}

export interface TrackActions {
  /** Dislike the current track: reroll (same vibe) + Reject it, then move on. */
  dislike: () => void;
  /** Permanently delete the current track without emitting feedback. */
  deleteTrack: () => void;
  /** Sync what a settled save-picker commit returned (retention is membership —
   * the picker is the only save path; this reflects its result). */
  applyRetentionFlags: (
    trackId: string,
    flags: TrackRetentionFlags,
    inCuratedPlaylist: boolean,
  ) => void;
  /** Show what an Assistant write added to a Track (a Favorite, a Playlist).
   *  Not a newer choice of the star's: a star answer still on its way settles
   *  with this addition on top. */
  applyRetentionAdded: (trackId: string, added: RetentionAdded) => void;
  /** Toggle Favorite; Favorite implies Save. */
  toggleFavorite: () => void;
  /** Record the Skip soft-negative audit event (best-effort). */
  reportSkip: (track: PlayableTrack) => void;
}

export function useTrackActions(deps: TrackActionDeps): TrackActions {
  // The controller publishes these actions through a memoized API. Keep that
  // public action surface stable while reading the latest controller ports at
  // event time, so callers do not need to memoize every port they provide.
  const depsRef = useRef(deps);
  depsRef.current = deps;
  // Serialize Save and Favorite writes per Track because both mutate the Save
  // floor (`favoritedAt ⇒ savedAt`); responses must never settle out of order.
  const retentionPendingRef = useRef<Set<string>>(new Set());
  // Each star tap and picker commit moves its Track's version forward. A star
  // answer lands only if its Track's version is still the one from its tap;
  // otherwise a newer choice already stands and the answer writes nothing.
  const retentionVersionRef = useRef<Map<string, number>>(new Map());
  // The Assistant's additions to a Track while its star answer is on its way.
  // A failed star never reached the server, so the server holds the flags from
  // before the tap with these on top; that is what the star settles to.
  const retentionAddedRef = useRef<Map<string, RetentionAdded[]>>(new Map());
  // A removal advances before its request settles, so a second tap in that
  // window would remove the next, unheard Track (for Reroll, possibly buying a
  // fresh generation). Held for the request only, not until a new Track arrives.
  const removalInFlightRef = useRef(false);

  const removeCurrentTrack = useCallback(
    (
      request: (trackId: string) => Promise<{ ok: boolean }>,
      act: PlayerAct,
      failureMessage: string,
    ) => {
      const {
        sourceId,
        activeTrack,
        markRemoved,
        unmarkRemoved,
        removeFromQueue,
        advancePastCurrent,
        queueChanged,
      } = depsRef.current;
      const track = activeTrack();
      if (!track || removalInFlightRef.current) return;
      removalInFlightRef.current = true;
      clearPlayerError(sourceId, act);
      void request(track.trackId).then((res) => {
        removalInFlightRef.current = false;
        if (!res.ok) {
          unmarkRemoved(track.queueItemId);
          showPlayerError(sourceId, act, failureMessage);
          return;
        }
        queueChanged();
      });
      markRemoved(track.queueItemId);
      removeFromQueue(track.queueItemId);
      advancePastCurrent();
    },
    [],
  );

  /** Dislike: Reject + reroll happen server-side. The local suppression keeps
   * stale poll responses from replaying the Track before the write settles. */
  const dislike = useCallback(() => {
    removeCurrentTrack(
      dislikeTrack,
      'dislike',
      'Dislike failed — the track stays in your session. Try again.',
    );
  }, [removeCurrentTrack]);

  const deleteTrack = useCallback(() => {
    removeCurrentTrack(
      deleteTrackRequest,
      'delete-track',
      'Delete failed — the track stays in your session. Try again.',
    );
  }, [removeCurrentTrack]);

  /** The save picker owns the write; this applies its settled result to the
   * live track + render state (no optimistic step — the sheet already showed
   * progress and surfaced errors itself). */
  const applyRetentionFlags = useCallback(
    (trackId: string, flags: TrackRetentionFlags, inCuratedPlaylist: boolean) => {
      const { activeTrack, patch } = depsRef.current;
      bumpVersion(retentionVersionRef.current, trackId);
      const track = activeTrack();
      if (!track || track.trackId !== trackId) return;
      applyFlags(track, flags);
      track.inCuratedPlaylist = inCuratedPlaylist;
      patchFlags(track, patch);
    },
    [],
  );

  const applyRetentionAdded = useCallback((trackId: string, added: RetentionAdded) => {
    const { activeTrack, patch } = depsRef.current;
    retentionAddedRef.current.get(trackId)?.push(added);
    const track = activeTrack();
    if (!track || track.trackId !== trackId) return;
    applyFlags(track, withRetentionAdded(flagsOf(track), added, new Date().toISOString()));
    if (added.curated) track.inCuratedPlaylist = true;
    patchFlags(track, patch);
  }, []);

  const toggleFavorite = useCallback(() => {
    const { sourceId, activeTrack, patch } = depsRef.current;
    const track = activeTrack();
    if (!track || retentionPendingRef.current.has(track.trackId)) return;
    retentionPendingRef.current.add(track.trackId);
    const version = bumpVersion(retentionVersionRef.current, track.trackId);
    const addedSinceTap: RetentionAdded[] = [];
    retentionAddedRef.current.set(track.trackId, addedSinceTap);
    clearPlayerError(sourceId, 'favorite');
    const previous = flagsOf(track);
    const favorited = previous.favoritedAt == null;
    applyFlags(track, optimisticFavoriteFlags(previous, favorited, new Date().toISOString()));
    patchFlags(track, patch);
    void favoriteTrack(track.trackId, favorited).then((res) => {
      retentionPendingRef.current.delete(track.trackId);
      retentionAddedRef.current.delete(track.trackId);
      if (retentionVersionRef.current.get(track.trackId) !== version) return;
      const settledAt = new Date().toISOString();
      applyFlags(
        track,
        addedSinceTap.reduce(
          (flags, added) => withRetentionAdded(flags, added, settledAt),
          settleTrackFlags(previous, res.ok ? res.data : null),
        ),
      );
      if (activeTrack()?.trackId === track.trackId) {
        patchFlags(track, patch);
      }
      if (!res.ok) {
        showPlayerError(
          sourceId,
          'favorite',
          favorited
            ? 'Favorite failed — this track was not starred. Try again.'
            : 'Unfavorite failed — this track is still starred. Try again.',
        );
      }
    });
  }, []);

  /** Skip is also a soft-negative: record the audit event. */
  const reportSkip = useCallback((track: PlayableTrack) => {
    const { sessionId } = depsRef.current;
    if (!sessionId) return;
    void sendFeedback({
      trackId: track.trackId,
      sessionId,
      type: 'skip',
      value: null,
      freeformText: null,
    });
  }, []);

  return {
    dislike,
    deleteTrack,
    applyRetentionFlags,
    applyRetentionAdded,
    toggleFavorite,
    reportSkip,
  };
}

function bumpVersion(versions: Map<string, number>, trackId: string): number {
  const next = (versions.get(trackId) ?? 0) + 1;
  versions.set(trackId, next);
  return next;
}

function flagsOf(track: PlayableTrack): TrackRetentionFlags {
  return { savedAt: track.savedAt, favoritedAt: track.favoritedAt };
}

function applyFlags(track: PlayableTrack, flags: TrackRetentionFlags): void {
  track.savedAt = flags.savedAt;
  track.favoritedAt = flags.favoritedAt;
}

function patchFlags(track: PlayableTrack, patch: TrackActionDeps['patch']): void {
  patch({
    currentFavorited: track.favoritedAt != null,
    currentInCuratedPlaylist: track.inCuratedPlaylist,
  });
}
