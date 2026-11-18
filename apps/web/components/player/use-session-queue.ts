'use client';

// Session Queue polling + projection (the Queue is the
// server-authoritative playback order). Split from the controller hook so the
// fetch mechanics — the adaptive cadence, aborting, non-overlap, and the
// item → PlayableTrack projection — change independently of playback logic.
// The cadence machine itself lives in `queue-poller.ts`.

import { useCallback, useEffect, useRef } from 'react';
import {
  LIVE_QUEUE_ITEM_STATES,
  type GetSessionQueueResponse,
  type PendingGeneration,
  type QueueItem,
  type SessionVibe,
} from '@liedmotif/shared';
import { getSessionQueue } from '@/lib/api-client';
import { watchSessionFinals } from '@/lib/offline/library-writes';
import { createQueuePoller, type QueuePollSignals } from './queue-poller';
import type { PlayableTrack } from './playable-track';

type QueueData = Extract<GetSessionQueueResponse, { ok: true }>['data'];

/** The states a listener has not consumed yet. Played/skipped/rejected/failed
 * slots stay in the playing order forever, so "anything playable" would mask
 * the mid-session waits the urgent cadence exists for. */
const FRESH_QUEUE_STATES = new Set<QueueItem['state']>(LIVE_QUEUE_ITEM_STATES);

/** One applied poll result: the playable projection + the session signals. */
export interface SessionQueueSnapshot {
  kind: 'session';
  /** The live New music policy; absent from a response that does not carry it. */
  sessionMode?: QueueData['sessionMode'];
  targetDurationMinutes?: number | null;
  generatedDurationSeconds?: number;
  unknownDurationTrackCount?: number;
  tracks: PlayableTrack[];
  /** Ordered server Queue slots for honest player presentation (windowed:
   *  recent history + everything from the current item forward). */
  items: QueueItem[];
  /** Playable Tracks the server's read window elided before `tracks`. */
  earlierTracks: number;
  /** The Session's first playable Track when the read window left it out:
   *  ordered play wraps from the last Track to it. Absent or null otherwise. */
  loopHead?: PlayableTrack | null;
  /** Every authoritative Queue item id, including slots that cannot currently
   *  enter the playable projection because their source is unavailable. */
  queueItemIds: ReadonlySet<string>;
  currentQueueItemId: string | null;
  currentTrackId: string | null;
  /** The stored place as a slot position, kept when its Track is gone. */
  anchorPosition?: number | null;
  generationStatus: QueueData['generationStatus'];
  generationStatusScope: QueueData['generationStatusScope'];
  statusMessageSafe: string | null;
  sessionStatus: QueueData['sessionStatus'];
  coverImageId: string | null;
  /** The session's LIVE style revision — a move is a Change Vibe (the
   *  controller clears a repeat-one loop pin on it). */
  styleRevision: number;
  /** Tracks in-flight provider jobs still owe (buffer top-ups, Dislike
   *  rerolls, Change Vibe fills) that have not reached the Queue as slots. */
  generatingTracksAhead: number;
  /** The part of that count ordered at the Session's live style revision. */
  generatingNewVibeTracksAhead: number;
  /** The in-flight generation while nothing is playable yet. */
  pendingGeneration: PendingGeneration | null;
  /** The current vibe facets — the Change Vibe overlay's preselection source. */
  vibe: SessionVibe | null;
  /** True while a switch-now vibe change is armed server-side. */
  switchPending: boolean;
  /** Tracks one Try again buys; null when Try again is not offered. */
  tryAgainTracks: number | null;
}

/** The playable projection: only items with a resolved track AND at least one
 * pinned playable source (same-origin), minus items `isLocallyRemoved`
 * (a stale response may predate a local removal's server-side write). */
function playableTracks(
  data: QueueData,
  isLocallyRemoved: (queueItemId: string) => boolean,
): PlayableTrack[] {
  return data.items.flatMap((item) => playableTrack(item, isLocallyRemoved) ?? []);
}

function playableTrack(
  item: QueueItem,
  isLocallyRemoved: (queueItemId: string) => boolean,
): PlayableTrack | null {
  const track = item.track;
  if (!track || isLocallyRemoved(item.id)) return null;
  if (!item.assets.final && !item.assets.stream) return null;
  return {
    queueItemId: item.id,
    trackId: item.trackId ?? track.id,
    queueState: item.state,
    vibeSwitchSetAside: item.vibeSwitchSetAside,
    title: track.title,
    artist: track.generatedArtistName,
    originSessionTitle: null,
    durationSeconds: item.durationSeconds ?? track.durationSeconds,
    coverImageId: track.coverImageId,
    savedAt: track.savedAt,
    inCuratedPlaylist: track.inCuratedPlaylist,
    favoritedAt: track.favoritedAt,
    genreTags: track.genreTags,
    vocalMode: track.vocalMode,
    hasLyrics: track.hasLyrics,
    downloadable: track.downloadable,
    assets: item.assets,
    styleRevision: item.styleRevision,
    targetBpm: item.targetBpm,
    targetKey: item.targetKey,
    blendAnalysis: item.blendAnalysis,
    queuePosition: item.position,
  };
}

/** Every authoritative Queue item id. The loop head is in the Queue too, only
 * outside the window: right after the wrap it is the audible Track while polls
 * still answer the old window. */
function queueItemIds(data: QueueData): Set<string> {
  const ids = new Set(data.items.map((item) => item.id));
  if (data.loopHead) ids.add(data.loopHead.id);
  return ids;
}

function sessionQueueSnapshot(
  data: QueueData,
  tracks: PlayableTrack[],
  isLocallyRemoved: (queueItemId: string) => boolean,
): SessionQueueSnapshot {
  return {
    kind: 'session',
    sessionMode: data.sessionMode,
    targetDurationMinutes: data.targetDurationMinutes,
    generatedDurationSeconds: data.generatedDurationSeconds,
    unknownDurationTrackCount: data.unknownDurationTrackCount,
    tracks,
    items: data.items.filter((item) => !isLocallyRemoved(item.id)),
    earlierTracks: data.earlierTracks,
    loopHead: data.loopHead ? playableTrack(data.loopHead, isLocallyRemoved) : null,
    queueItemIds: queueItemIds(data),
    currentQueueItemId: data.currentQueueItemId,
    currentTrackId: data.currentTrackId,
    anchorPosition: data.anchorPosition,
    generationStatus: data.generationStatus,
    generationStatusScope: data.generationStatusScope,
    statusMessageSafe: data.statusMessageSafe,
    sessionStatus: data.sessionStatus,
    coverImageId: data.coverImageId,
    styleRevision: data.styleRevision,
    generatingTracksAhead: data.generatingTracksAhead,
    generatingNewVibeTracksAhead: data.generatingNewVibeTracksAhead,
    pendingGeneration: data.pendingGeneration,
    vibe: data.vibe,
    switchPending: data.switchPending,
    tryAgainTracks: data.tryAgainTracks,
  };
}

function pollSignals(data: QueueData, tracks: PlayableTrack[]): QueuePollSignals {
  return {
    sessionStatus: data.sessionStatus,
    generationCanChangeQueue: data.generationStatus === 'ok',
    hasPendingGeneration: data.pendingGeneration != null,
    switchPending: data.switchPending,
    hasPlayableFreshTrack: tracks.some((track) => FRESH_QUEUE_STATES.has(track.queueState)),
  };
}

/**
 * Poll the Session Queue and hand each successful response to `onSnapshot` as
 * a playable projection. At most one request is in flight; the cadence adapts
 * to what the response says the player is waiting on (see `queue-poller.ts`).
 * Returns a stable wake-up: poll now (used after Queue-changing mutations and
 * on re-engage).
 */
export function useSessionQueue(
  /** Null (a Playlist source) = no polling; the caller supplies its own snapshot. */
  sessionId: string | null,
  isLocallyRemoved: (queueItemId: string) => boolean,
  onSnapshot: (snapshot: SessionQueueSnapshot) => void,
  /** Live playback probe (ref-backed): hidden-tab audio must not poll as idle. */
  getIsPlaying: () => boolean,
  /** Read every slot instead of the window: Shuffle traverses the whole
   *  Session, and only this device knows Shuffle is selected. */
  fullRead = false,
): () => void {
  const pollNowRef = useRef<() => void>(() => {});
  const fullReadRef = useRef(fullRead);
  useEffect(() => {
    if (fullReadRef.current === fullRead) return;
    fullReadRef.current = fullRead;
    pollNowRef.current();
  }, [fullRead]);

  useEffect(() => {
    if (!sessionId) return;
    const sawFinals = watchSessionFinals(sessionId);

    const poll = async (signal: AbortSignal) => {
      const res = await getSessionQueue(sessionId, signal, { full: fullReadRef.current });
      if (!res.ok) return { ok: false as const };
      const tracks = playableTracks(res.data, isLocallyRemoved);
      onSnapshot(sessionQueueSnapshot(res.data, tracks, isLocallyRemoved));
      sawFinals(tracks.flatMap((track) => (track.assets.final ? [track.trackId] : [])));
      return { ok: true as const, signals: pollSignals(res.data, tracks) };
    };

    const poller = createQueuePoller({
      poll,
      isPlaying: getIsPlaying,
      isHidden: () => document.visibilityState === 'hidden',
    });
    // A quiet hidden tab re-syncs the moment it is looked at again, and a
    // regained connection does not wait out a backed-off delay.
    const onVisible = () => {
      if (document.visibilityState === 'visible') poller.pollNow();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', poller.pollNow);
    pollNowRef.current = poller.pollNow;
    poller.start();
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', poller.pollNow);
      pollNowRef.current = () => {};
      poller.dispose();
    };
  }, [sessionId, isLocallyRemoved, onSnapshot, getIsPlaying]);

  return useCallback(() => pollNowRef.current(), []);
}
