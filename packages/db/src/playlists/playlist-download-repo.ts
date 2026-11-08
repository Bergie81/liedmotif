// Track selection for the Playlist zip download route. Read-only: resolves the
// owned playlist (its name feeds the zip filename) and the members whose
// downloaded local finals can be zipped, in playlist position order.

import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../client';
import {
  downloadableTrackColumns,
  MAX_EXPORT_TRACKS,
  servableLocalFinalConditions,
  type DownloadableTrack,
} from '../generation/audio-asset-predicates';
import { playlists, playlistTracks, tracks, trackAudioAssets } from '../schema';

export interface PlaylistDownloadTracks {
  playlist: { id: string; name: string };
  tracks: DownloadableTrack[];
}

/**
 * A Playlist's downloadable member Tracks, strictly owner-scoped (null for an
 * absent/foreign playlist — the route's uniform-404 posture). Disliked/deleted
 * members cannot exist (membership is purged in the same transaction), so the
 * only filter needed is the servable `local_original` join — a member saved
 * before its final landed (stream-only) is skipped. Favorites is a playlist
 * like any other here. Bounded by `MAX_EXPORT_TRACKS`, in position order.
 */
export async function getOwnedPlaylistDownloadTracks(
  db: Database,
  args: { ownerUserId: string; playlistId: string },
): Promise<PlaylistDownloadTracks | null> {
  const [playlist] = await db
    .select({ id: playlists.id, name: playlists.name })
    .from(playlists)
    .where(and(eq(playlists.id, args.playlistId), eq(playlists.ownerUserId, args.ownerUserId)))
    .limit(1);
  if (!playlist) return null;

  const rows = await db
    .select(downloadableTrackColumns())
    .from(playlistTracks)
    .innerJoin(
      tracks,
      and(eq(tracks.id, playlistTracks.trackId), eq(tracks.ownerUserId, args.ownerUserId)),
    )
    .innerJoin(
      trackAudioAssets,
      and(eq(trackAudioAssets.trackId, tracks.id), servableLocalFinalConditions()),
    )
    .where(eq(playlistTracks.playlistId, playlist.id))
    .orderBy(asc(playlistTracks.position))
    .limit(MAX_EXPORT_TRACKS);

  return { playlist, tracks: rows };
}
