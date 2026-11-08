// The offline manifest: for one marked collection, the Tracks a device may
// store and what it keeps besides their audio. Which Tracks qualify is
// Download's servable-local-final predicate over what the viewer may hear —
// their own Tracks, and other owners' Tracks while Lounge-audible to them. A
// copy kept inside the app is a listen, not a Download, so
// the read scope applies where Download keeps the owner scope.
// The per-Track projection is shared by every collection kind.

import {
  and,
  asc,
  count,
  countDistinct,
  eq,
  inArray,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { OfflineManifest, OfflineManifestTrack } from '@liedmotif/shared';
import type { Database } from '../client';
import { effectiveTrackCoverColumn } from '../covers/effective-track-cover';
import {
  downloadableTrackColumns,
  MAX_EXPORT_TRACKS,
  servableLocalFinalConditions,
  type DownloadableTrack,
} from '../generation/audio-asset-predicates';
import { getOwnedSessionDownloadTracks } from '../generation/download-tracks-repo';
import { trackHasLyricsColumn } from '../generation/lyrics-repo';
import { sessionNotPendingDelete } from '../generation/session-list-repo';
import {
  playableSessionTrackCondition,
  sessionTrackQueueEdge,
} from '../generation/session-track-playability';
import { playlistLoungeVisibleTo, viewerCanReadTrack } from '../playlists/lounge-audible';
import {
  activitySessionQueueItems,
  activitySessions,
  generationRequests,
  listenerProfiles,
  playlists,
  playlistTracks,
  trackAudioAssets,
  tracks,
} from '../schema';
import { user } from '../schema/auth';

/**
 * A digest of everything a stored offline copy shows besides the audio that
 * can change after the Track lands: its names (Track Data's artist resolves
 * from the owner's Artist Name and User name, `resolveArtistName`), length,
 * measured BPM, cover, and whether its words and their timing are captured
 * (both write-once). A device refreshes its copy's metadata when this moves;
 * the audio itself is fetched once.
 */
function offlineVersionColumn(): SQL<string> {
  return sql<string>`md5(row(
    ${tracks.title},
    ${tracks.generatedArtistName},
    ${listenerProfiles.artistName},
    ${user.name},
    ${tracks.durationSeconds},
    ${tracks.bpmEstimate},
    ${tracks.lyrics} is not null,
    ${tracks.timedLyrics} is not null,
    ${activitySessions.title},
    ${effectiveTrackCoverColumn(activitySessions.coverImageId, tracks.coverImageId)}
  )::text)`;
}

/** Projects a selection of storable Tracks into manifest entries, keeping its order. */
async function toOfflineManifestTracks(
  db: Database,
  viewerUserId: string,
  selection: DownloadableTrack[],
): Promise<OfflineManifestTrack[]> {
  if (selection.length === 0) return [];
  const rows = await db
    .select({
      trackId: tracks.id,
      version: offlineVersionColumn(),
      title: tracks.title,
      artist: tracks.generatedArtistName,
      originSessionTitle: activitySessions.title,
      durationSeconds: tracks.durationSeconds,
      coverImageId: effectiveTrackCoverColumn(activitySessions.coverImageId, tracks.coverImageId),
      genreTags: tracks.genreTags,
      vocalMode: tracks.vocalMode,
      hasLyrics: trackHasLyricsColumn(),
      fromLounge: sql<boolean>`${tracks.ownerUserId} <> ${viewerUserId}`,
    })
    .from(tracks)
    .innerJoin(user, eq(user.id, tracks.ownerUserId))
    .leftJoin(listenerProfiles, eq(listenerProfiles.ownerUserId, tracks.ownerUserId))
    .leftJoin(generationRequests, eq(generationRequests.id, tracks.generationRequestId))
    .leftJoin(activitySessions, eq(activitySessions.id, generationRequests.activitySessionId))
    .where(
      inArray(
        tracks.id,
        selection.map((track) => track.trackId),
      ),
    );
  const byId = new Map(rows.map((row) => [row.trackId, row]));
  return selection.flatMap((track) => {
    const row = byId.get(track.trackId);
    return row ? [{ ...row, byteSize: track.byteSize }] : [];
  });
}

/**
 * The manifest of one Playlist the viewer may hear: their own (Favorites
 * included), or one in their Lounge. Members in position order, each one the
 * viewer can hear — the owner-anchored Lounge-audible predicate, so a Shared
 * reference the Track's own owner does not share with the viewer never
 * appears — and bounded like an export (`MAX_EXPORT_TRACKS`). Null for an
 * absent Playlist, another owner's Private one, or one whose audience leaves
 * the viewer out: the route's uniform 404. An empty Playlist is a manifest
 * with no Tracks, not an absence.
 */
export async function getReadablePlaylistOfflineManifest(
  db: Database,
  args: { viewerUserId: string; playlistId: string },
): Promise<OfflineManifest | null> {
  const [playlist] = await db
    .select({ id: playlists.id, name: playlists.name })
    .from(playlists)
    .where(
      and(
        eq(playlists.id, args.playlistId),
        or(
          eq(playlists.ownerUserId, args.viewerUserId),
          playlistLoungeVisibleTo(args.viewerUserId),
        ),
      ),
    )
    .limit(1);
  if (!playlist) return null;

  const audibleMember = and(
    eq(playlistTracks.playlistId, playlist.id),
    viewerCanReadTrack(args.viewerUserId),
  );

  const selection = await db
    .select(downloadableTrackColumns())
    .from(playlistTracks)
    .innerJoin(tracks, eq(tracks.id, playlistTracks.trackId))
    .innerJoin(
      trackAudioAssets,
      and(eq(trackAudioAssets.trackId, tracks.id), servableLocalFinalConditions()),
    )
    .where(audibleMember)
    .orderBy(asc(playlistTracks.position))
    .limit(MAX_EXPORT_TRACKS);

  const selectedIds = selection.map((track) => track.trackId);
  // By exclusion, not subtraction: a member removed between the two reads must
  // not turn the count negative, which the contract rejects.
  const [leftOut] = await db
    .select({ count: count() })
    .from(playlistTracks)
    .innerJoin(tracks, eq(tracks.id, playlistTracks.trackId))
    .where(and(audibleMember, notInArray(tracks.id, selectedIds)));

  return {
    name: playlist.name,
    tracks: await toOfflineManifestTracks(db, args.viewerUserId, selection),
    leftOutTrackCount: leftOut?.count ?? 0,
  };
}

/**
 * The manifest of one owned Session, its Tracks in play order — Ephemeral ones
 * included, since their audio never expires on its own. Null for an absent,
 * foreign or deleted Session (a pending delete counts as deleted): the route's
 * uniform 404. A Session with nothing stored yet is a manifest with no Tracks.
 */
export async function getOwnedSessionOfflineManifest(
  db: Database,
  args: { ownerUserId: string; sessionId: string },
): Promise<OfflineManifest | null> {
  const [session] = await db
    .select({ title: activitySessions.title })
    .from(activitySessions)
    .where(
      and(
        eq(activitySessions.id, args.sessionId),
        eq(activitySessions.ownerUserId, args.ownerUserId),
        sessionNotPendingDelete(),
      ),
    )
    .limit(1);
  if (!session) return null;

  const selection = await getOwnedSessionDownloadTracks(db, args);
  // Counted against the Session's own playable predicate, which is what its card
  // counts, and by exclusion because the selection also takes Tracks that
  // predicate does not (a rejected Queue slot's).
  const [leftOut] = await db
    .select({ count: countDistinct(tracks.id) })
    .from(generationRequests)
    .innerJoin(tracks, eq(tracks.generationRequestId, generationRequests.id))
    .leftJoin(activitySessionQueueItems, sessionTrackQueueEdge)
    .where(
      and(
        eq(generationRequests.activitySessionId, args.sessionId),
        eq(generationRequests.ownerUserId, args.ownerUserId),
        playableSessionTrackCondition(args.ownerUserId),
        notInArray(
          tracks.id,
          selection.map((track) => track.trackId),
        ),
      ),
    );

  return {
    name: session.title ?? 'Untitled Session',
    tracks: await toOfflineManifestTracks(db, args.ownerUserId, selection),
    leftOutTrackCount: leftOut?.count ?? 0,
  };
}
