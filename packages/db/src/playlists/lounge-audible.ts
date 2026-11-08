// The Lounge-audible predicate — the db half of the one
// access predicate pair (the pure half is `canReadCover` in `@liedmotif/shared`).
// It is per viewer: a playlist is visible to V iff it is In Lounge and V is its
// owner, or its audience is `everyone`, or V is one of its `selected` Users
// (`playlistLoungeVisibleTo`). A Track is Lounge-audible to V iff it currently
// belongs to >= 1 playlist OF ITS OWNER that is visible to V — owner-anchored,
// so a Shared reference in somebody else's In-Lounge playlist can never widen
// exposure beyond the audience the track's owner chose. Every cross-owner read
// path composes `viewerCanReadTrack` (owner OR Lounge-audible); no route or
// repo derives its own version. Writes never widen: mutations keep their strict
// owner scope — the Shared-reference save composes this predicate only to READ
// the foreign track it points at, while the rows it writes stay in the
// visitor's own playlists.

import { and, eq, exists, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../client';
import {
  activitySessions,
  coverImages,
  generationRequests,
  playlistPins,
  playlists,
  playlistShareMembers,
  playlistTracks,
  tracks,
} from '../schema';

/**
 * Whether a playlist row is in the Lounge for `viewer`. `playlist` names the
 * row in scope — the unaliased `playlists` by default, or an alias such as
 * sql`vp` in raw SQL — and `viewer` is a user id or a correlated column, so
 * the revocation purge can ask it about every visitor at once. The one
 * derivation of share visibility: everything per-viewer composes it.
 */
export function playlistLoungeVisibleTo(
  viewer: string | SQL,
  playlist: SQL = sql`${playlists}`,
): SQL<boolean> {
  return sql<boolean>`(${playlist}."shared_at" is not null and (
    ${playlist}."owner_user_id" = ${viewer}
    or ${playlist}."share_audience" = 'everyone'
    or exists(
      select 1 from ${playlistShareMembers} psm
      where psm.playlist_id = ${playlist}."id" and psm.user_id = ${viewer}
    )
  ))`;
}

/**
 * Whether a track is Lounge-audible to `viewer`. `track` names the track row
 * in scope — the unaliased `tracks` by default, or an alias such as sql`t` in
 * raw SQL — and `viewer` is a user id or a correlated column, like
 * `playlistLoungeVisibleTo`.
 */
export function trackIsLoungeAudible(
  viewer: string | SQL,
  track: SQL = sql`${tracks}`,
): SQL<boolean> {
  return sql<boolean>`exists(
    select 1 from ${playlistTracks} aud_pt
    join ${playlists} aud_p on aud_p.id = aud_pt.playlist_id
    where aud_pt.track_id = ${track}."id"
      and aud_p.owner_user_id = ${track}."owner_user_id"
      and ${playlistLoungeVisibleTo(viewer, sql`aud_p`)}
  )`;
}

/**
 * The widened READ scope: the viewer owns the track, or the track
 * is Lounge-audible. Drop-in for the `eq(tracks.ownerUserId, ...)` leg of an
 * owner-scoped read's where-clause — a missing, cross-owner-private, and
 * revoked id all stay indistinguishable (no rows → the caller's uniform 404).
 */
export function viewerCanReadTrack(viewerUserId: string): SQL {
  return or(eq(tracks.ownerUserId, viewerUserId), trackIsLoungeAudible(viewerUserId))!;
}

/**
 * Whether one member of the playlist in scope (`playlists`, correlated) counts
 * toward what `viewer` is shown of that playlist — its counts, mosaic, search
 * text, and whether it is listed at all. A member is the playlist owner's own
 * track, or a Shared reference Lounge-audible to the viewer: the track's own
 * owner chose its audience, and a re-shared playlist must not carry a
 * reference past it. For a playlist in the viewer's Lounge this selects the
 * same members as `viewerCanReadTrack` (the owner's tracks are audible through
 * that very playlist). `track` is the joined member track's alias.
 */
export function playlistMemberVisibleTo(viewer: string, track: SQL): SQL<boolean> {
  return sql<boolean>`(${track}."owner_user_id" = ${playlists}."owner_user_id"
    or ${trackIsLoungeAudible(viewer, track)})`;
}

/**
 * The playlists a viewer's Search covers: their own rows, plus foreign playlists
 * they pinned that are still in the Lounge for them. The visibility check keeps a
 * revoked row invisible even if a purge path ever missed its pin (belt over the
 * in-transaction purge, never a substitute for it). Correlates on
 * `playlists`, so the select it joins must have `playlists` in scope. Search only:
 * nowhere else does a Pin list among the viewer's own playlists, and a Pin is
 * never a save target.
 */
export function viewerCanSearchPlaylist(viewerUserId: string): SQL {
  return or(
    eq(playlists.ownerUserId, viewerUserId),
    and(
      playlistLoungeVisibleTo(viewerUserId),
      sql`exists(
        select 1 from ${playlistPins} pp
        where pp.playlist_id = ${playlists}."id"
          and pp.visitor_user_id = ${viewerUserId}
      )`,
    ),
  )!;
}

/**
 * Whether the Lounge currently exposes this cover to the viewer: it fronts a
 * track Lounge-audible to them — as its session's cover, or as the track's own
 * art where the session has none (the `effectiveTrackCoverColumn` precedence)
 * — or it is the custom cover of a playlist in the Lounge for them (the
 * Lounge page tile). Resolved here because the covers route decides about a
 * FETCHED row (`canReadCover`), where a where-clause cannot reach.
 */
export async function isCoverLoungeVisible(
  db: Database,
  coverImageId: string,
  viewerUserId: string,
): Promise<boolean> {
  const audibleTrackUnderSessionCover = db
    .select({ x: sql`1` })
    .from(tracks)
    .innerJoin(generationRequests, eq(generationRequests.id, tracks.generationRequestId))
    .innerJoin(activitySessions, eq(activitySessions.id, generationRequests.activitySessionId))
    .where(
      and(eq(activitySessions.coverImageId, coverImages.id), trackIsLoungeAudible(viewerUserId)),
    );
  const audibleTrackWithOwnCover = db
    .select({ x: sql`1` })
    .from(tracks)
    .leftJoin(generationRequests, eq(generationRequests.id, tracks.generationRequestId))
    .leftJoin(activitySessions, eq(activitySessions.id, generationRequests.activitySessionId))
    .where(
      and(
        eq(tracks.coverImageId, coverImages.id),
        isNull(activitySessions.coverImageId),
        trackIsLoungeAudible(viewerUserId),
      ),
    );
  const inLoungePlaylistCover = db
    .select({ x: sql`1` })
    .from(playlists)
    .where(and(eq(playlists.coverImageId, coverImages.id), playlistLoungeVisibleTo(viewerUserId)));

  const [row] = await db
    .select({
      visible: sql<boolean>`${exists(audibleTrackUnderSessionCover)} or ${exists(
        audibleTrackWithOwnCover,
      )} or ${exists(inLoungePlaylistCover)}`,
    })
    .from(coverImages)
    .where(eq(coverImages.id, coverImageId))
    .limit(1);
  return row?.visible ?? false;
}
