// What the Offline Library makes of this device's offline store: the offline
// collections it lists, the Track list it hands the Player, and the Player's
// view of each Track's cover, lyrics and Track Data. Everything comes from the
// device; nothing here can reach the server.

import type { TrackLyrics } from '@liedmotif/shared';
import type { PlayableTrack } from '@/components/player/playable-track';
import type { SourceNoun } from '@/components/player/player-presentation';
import type { TrackMedia } from '@/components/player/track-media';
import type { OfflineMark, OfflineMarkKind, OfflineTrackCopy } from '@/lib/offline/offline-store';
import { offlineCopyPlayable } from '@/lib/offline/offline-sync-plan';

/** One Available-offline collection as this device can play it. */
export interface OfflineCollection {
  /** The offline mark's key, also the Player's source id. */
  key: string;
  kind: OfflineMarkKind;
  name: string;
  /** The stored Tracks that may play, in play order; one the device has not
   *  finished fetching is left out. */
  tracks: OfflineTrackCopy[];
  /** Stored Lounge Tracks held back until a sync confirms them again. */
  expiredCount: number;
}

/** The collections as they may play at `now`, given the last successful sync. */
export function offlineCollections(
  marks: readonly OfflineMark[],
  copies: readonly OfflineTrackCopy[],
  lastSyncedAt: number | null,
  now: number,
): OfflineCollection[] {
  const held = new Map(copies.map((copy) => [copy.trackId, copy]));
  return marks
    .map((mark) => {
      const stored = mark.manifest.tracks.flatMap((entry) => held.get(entry.trackId) ?? []);
      const tracks = stored.filter((copy) => offlineCopyPlayable(copy.track, lastSyncedAt, now));
      return {
        key: mark.key,
        kind: mark.kind,
        name: mark.manifest.name,
        tracks,
        expiredCount: stored.length - tracks.length,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether a stored Track's copy has expired at `now()`: the one expiry rule,
 *  re-judged at every call, so a Player can ask it before every start. A Track
 *  the device does not hold has nothing to expire. */
export function offlineCopyExpired(
  copies: readonly OfflineTrackCopy[],
  lastSyncedAt: number | null,
  now: () => number,
): (trackId: string) => boolean {
  const held = new Map(copies.map((copy) => [copy.trackId, copy.track]));
  return (trackId) => {
    const track = held.get(trackId);
    return track != null && !offlineCopyPlayable(track, lastSyncedAt, now());
  };
}

/** What a collection is called in the Offline Library and its Player: a
 *  Session, or a Playlist for every other kind of mark. */
export function offlineCollectionNoun(collection: Pick<OfflineCollection, 'kind'>): SourceNoun {
  return collection.kind === 'session' ? 'Session' : 'Playlist';
}

/** The Player's Track list for stored Tracks, each playing its device copy.
 *  Like a Playlist's, it has no blend identity: every edge is a plain crossfade. */
export function offlinePlayableTracks(
  tracks: readonly OfflineTrackCopy[],
  audioUrl: (trackId: string) => string | null,
): PlayableTrack[] {
  return tracks.map(({ trackId, track }) => ({
    queueItemId: trackId,
    trackId,
    queueState: 'queued',
    vibeSwitchSetAside: false,
    title: track.title,
    artist: track.artist,
    originSessionTitle: track.originSessionTitle,
    durationSeconds: track.durationSeconds,
    coverImageId: track.coverImageId,
    savedAt: null,
    favoritedAt: null,
    inCuratedPlaylist: false,
    genreTags: track.genreTags,
    vocalMode: track.vocalMode,
    hasLyrics: track.hasLyrics,
    downloadable: false,
    assets: { final: audioUrl(trackId), stream: null },
    styleRevision: null,
    targetBpm: null,
    targetKey: null,
    blendAnalysis: null,
  }));
}

/** An instrumental Track stores no lyrics. */
const NO_LYRICS: TrackLyrics = { state: 'instrumental', lines: [], synced: false, settled: true };

/** The Player's cover, lyrics and Track Data from the device. `coverUrls` maps
 *  a cover id to an object URL over its stored image. Offline nothing can
 *  improve on what is stored, so lyrics read as settled. */
export function offlineTrackMedia(
  copies: readonly OfflineTrackCopy[],
  coverUrls: ReadonlyMap<string, string>,
): TrackMedia {
  const held = new Map(copies.map((copy) => [copy.trackId, copy]));
  const coverSrc = (coverImageId: string | null) =>
    coverImageId ? (coverUrls.get(coverImageId) ?? null) : null;
  return {
    coverSrc,
    artwork(coverImageId) {
      const src = coverSrc(coverImageId);
      return src ? [{ src, sizes: '512x512' }] : [];
    },
    async lyrics(trackId) {
      const lyrics = held.get(trackId)?.lyrics ?? NO_LYRICS;
      return { ok: true, data: { ...lyrics, settled: true } };
    },
    async details(trackId) {
      const copy = held.get(trackId);
      if (!copy) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: 'This track is not on this device.',
            retryable: false,
          },
        };
      }
      return { ok: true, data: copy.details };
    },
  };
}
