// Map a DB track row to the contract `trackSummary`. The audio rule
// lives in ONE place: audio is exposed ONLY as a same-origin `/api/audio/<id>`
// path, and ONLY for a track that is both playable (has a downloaded asset) and in a
// playable lifecycle state — a Rejected/Deleted track never exposes audio even if a
// stale asset row lingers. Provider/stream URLs never reach the browser.

import type { LibraryTrack, OwnedTrackSummary, TrackFlagsResult } from '@liedmotif/db';
import type { LibraryTrackItem, TrackFlags, TrackSummary } from '@liedmotif/shared';

/** The row fields a `trackSummary` is built from — satisfied by both the
 *  library's `OwnedTrackSummary` and the queue view's `SessionQueueTrack`,
 *  so every route maps through the ONE function below. */
type TrackSummaryRow = Pick<
  OwnedTrackSummary,
  | 'id'
  | 'title'
  | 'generatedArtistName'
  | 'status'
  | 'durationSeconds'
  | 'coverImageId'
  | 'savedAt'
  | 'favoritedAt'
  | 'dislikedAt'
  | 'inCuratedPlaylist'
  | 'genreTags'
  | 'vocalMode'
  | 'hasLyrics'
  | 'hasPlayableAudio'
  | 'hasFinalAsset'
>;

/** Map the repo's resolved flags (Date columns) to the `trackFlagsSchema` payload. */
export function toTrackFlags(flags: TrackFlagsResult): TrackFlags {
  return {
    trackId: flags.trackId,
    savedAt: flags.savedAt?.toISOString() ?? null,
    favoritedAt: flags.favoritedAt?.toISOString() ?? null,
    dislikedAt: flags.dislikedAt?.toISOString() ?? null,
    retentionClass: flags.retentionClass,
  };
}

export function toTrackSummary(
  track: TrackSummaryRow,
  opts: {
    /** Drop the lifecycle-status gate and expose audio on asset presence alone
     *  (the queue view resolves per-source pins itself and gates there). A
     *  downloaded asset stays required either way. */
    assetPresenceOnly?: boolean;
  } = {},
): TrackSummary {
  const playableStatus = track.status === 'ready' || track.status === 'streamable';
  // A failed Track is never offered for play, whatever assets it still holds.
  const playable =
    track.hasPlayableAudio &&
    track.status !== 'failed' &&
    (opts.assetPresenceOnly || playableStatus);
  return {
    id: track.id,
    title: track.title,
    generatedArtistName: track.generatedArtistName,
    status: track.status,
    durationSeconds: track.durationSeconds,
    coverImageId: track.coverImageId,
    audioUrl: playable ? `/api/audio/${track.id}` : null,
    savedAt: track.savedAt?.toISOString() ?? null,
    favoritedAt: track.favoritedAt?.toISOString() ?? null,
    dislikedAt: track.dislikedAt?.toISOString() ?? null,
    inCuratedPlaylist: track.inCuratedPlaylist,
    genreTags: track.genreTags,
    vocalMode: track.vocalMode,
    hasLyrics: track.hasLyrics,
    // Downloads serve stored local finals only — a Rejected/Deleted track never
    // exposes one, mirroring the audio gate above.
    downloadable: track.hasFinalAsset && track.status === 'ready',
  };
}

export function toLibraryTrackItem(track: LibraryTrack): LibraryTrackItem {
  return {
    ...toTrackSummary(track),
    createdAt: track.createdAt.toISOString(),
    hasPlayed: track.hasPlayed,
    originSessionId: track.originSessionId,
    originSessionTitle: track.originSessionTitle,
  };
}
