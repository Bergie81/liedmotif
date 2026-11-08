'use client';

import { useEffect } from 'react';
import type { PlayableTrack } from './playable-track';
import type { PlayerControllerSource } from './playback-controller-api';
import { useSessionQueue, type SessionQueueSnapshot } from './use-session-queue';

export interface PlaylistQueueSnapshot {
  kind: 'playlist';
  tracks: PlayableTrack[];
  queueItemIds: ReadonlySet<string>;
  currentQueueItemId: string | null;
  currentTrackId: string | null;
}

export type PlaybackSourceSnapshot = SessionQueueSnapshot | PlaylistQueueSnapshot;

export function playlistQueueSnapshot(
  tracks: PlayableTrack[],
  startTrackId: string | null,
): PlaylistQueueSnapshot {
  return {
    kind: 'playlist',
    tracks,
    queueItemIds: new Set(tracks.map((track) => track.queueItemId)),
    currentQueueItemId: startTrackId,
    currentTrackId: startTrackId,
  };
}

/** Feed the transport from the authoritative source: a polled Session Queue or
 * one immutable Playlist membership snapshot. Returns the Session poll wake-up
 * (a no-op under a Playlist source). */
export function usePlaybackSourceQueue(
  source: PlayerControllerSource,
  isLocallyRemoved: (queueItemId: string) => boolean,
  onSnapshot: (snapshot: PlaybackSourceSnapshot) => void,
  getIsPlaying: () => boolean,
): () => void {
  const sessionId = source.kind === 'session' ? source.sessionId : null;
  const pollNow = useSessionQueue(sessionId, isLocallyRemoved, onSnapshot, getIsPlaying);

  // A Playlist has no server queue: its full ordered membership IS the
  // projection. `source` is memoized by the host, so one engagement applies
  // exactly one snapshot.
  useEffect(() => {
    if (source.kind !== 'playlist') return;
    onSnapshot(playlistQueueSnapshot(source.tracks, source.startTrackId));
  }, [source, onSnapshot]);

  return pollNow;
}
