// `isCuratedPlaylist` (`@liedmotif/shared`) as SQL, for the reads that project a
// track row. `savedAt` cannot answer this question: it is set by ANY
// membership, Favorites included (`favoritedAt => savedAt`).

import { and, eq, exists, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../client';
import { playlists, playlistTracks, tracks } from '../schema';

/**
 * Correlates on `tracks`, so the select it joins must have `tracks` in scope.
 * Only the track owner's own Playlists count: a Visitor's Shared reference is
 * never an owner fact.
 */
export function curatedPlaylistMemberColumn(db: Database) {
  return sql<boolean>`${exists(
    db
      .select({ x: sql`1` })
      .from(playlistTracks)
      .innerJoin(playlists, eq(playlists.id, playlistTracks.playlistId))
      .where(
        and(
          eq(playlistTracks.trackId, tracks.id),
          eq(playlists.ownerUserId, tracks.ownerUserId),
          eq(playlists.kind, 'user'),
          eq(playlists.listedInPlaylists, true),
        ),
      ),
  )}`;
}

/**
 * The retention shelves as ONE viewer may see them. An own track
 * serves the canonical `tracks` flags; a foreign (Lounge-audible) row serves
 * the VIEWER's membership-derived relationship instead — saved = filed in any
 * of the viewer's playlists, favorited = in their Favorites, never disliked —
 * because the track row's flags are the owner's Library facts and must not
 * travel cross-owner. Correlates on `tracks`, like every column here.
 */
export function viewerShelfColumns(db: Database, viewerUserId: string) {
  const own = sql`${tracks.ownerUserId} = ${viewerUserId}`;
  const viewerMembership = (extra: SQL) => sql`(
    select min(vpt.created_at)
    from ${playlistTracks} vpt
    join ${playlists} vp on vp.id = vpt.playlist_id
    where vpt.track_id = ${tracks.id} and vp.owner_user_id = ${viewerUserId} ${extra}
  )`;
  // Raw CASE columns bypass the column decoders, so each timestamp is mapped
  // back through its column's type (null skips the decoder).
  return {
    savedAt: sql<Date | null>`case when ${own} then ${tracks.savedAt}
      else ${viewerMembership(sql``)} end`.mapWith(tracks.savedAt),
    favoritedAt: sql<Date | null>`case when ${own} then ${tracks.favoritedAt}
      else ${viewerMembership(sql`and vp.kind = 'favorites'`)} end`.mapWith(tracks.favoritedAt),
    dislikedAt: sql<Date | null>`case when ${own} then ${tracks.dislikedAt}
      else null::timestamptz end`.mapWith(tracks.dislikedAt),
    inCuratedPlaylist: sql<boolean>`case when ${own} then ${curatedPlaylistMemberColumn(db)}
      else exists(
        select 1 from ${playlistTracks} vpt
        join ${playlists} vp on vp.id = vpt.playlist_id
        where vpt.track_id = ${tracks.id}
          and vp.owner_user_id = ${viewerUserId}
          and vp.kind = 'user' and vp.listed_in_playlists
      ) end`,
  } as const;
}
