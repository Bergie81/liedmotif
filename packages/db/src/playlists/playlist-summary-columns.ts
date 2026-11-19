import { sql, type SQL } from 'drizzle-orm';
import { effectiveTrackCoverColumn } from '../covers/effective-track-cover';
import { orphanedOnceUnsaved } from '../generation/eviction-repo';
import { servableLocalFinalConditions } from '../generation/audio-asset-predicates';
import {
  activitySessions,
  generationRequests,
  playlists,
  playlistTracks,
  trackAudioAssets,
  tracks,
} from '../schema';
import { playlistMemberVisibleTo } from './lounge-audible';

// Correlated summary columns for any query whose FROM is `playlists` — shared
// by the Playlists list and the search repo so a playlist's card facts cannot
// diverge between surfaces.
// NOTE: the correlated references must be spelled `${playlists}."id"` — a
// bare `${playlists.id}` renders UNQUALIFIED ("id") inside these subqueries
// and binds to the subquery's own tables.
//
// The member-derived columns take the `viewer` whenever the row may be
// another owner's playlist (the Lounge, Search): only members visible to that
// viewer count (`playlistMemberVisibleTo`). Owner-only reads pass none.

/** The extra member condition for `viewer` over the member track alias `t`. */
function visibleMemberCondition(viewer: string | undefined): SQL {
  return viewer === undefined ? sql`` : sql`and ${playlistMemberVisibleTo(viewer, sql`t`)}`;
}

/** Live member count. */
export function playlistTrackCountColumn(viewer?: string): SQL<number> {
  return sql<number>`(
    select count(*)::int
    from ${playlistTracks} pt
    join ${tracks} t on t.id = pt.track_id
    where pt.playlist_id = ${playlists}."id" ${visibleMemberCondition(viewer)}
  )`;
}

/** Whether the playlist has any member — the Lounge never lists an empty entry. */
export function playlistHasMembersCondition(viewer?: string): SQL<boolean> {
  return sql<boolean>`exists(
    select 1
    from ${playlistTracks} pt
    join ${tracks} t on t.id = pt.track_id
    where pt.playlist_id = ${playlists}."id" ${visibleMemberCondition(viewer)}
  )`;
}

/**
 * First 4 DISTINCT member covers in playlist order — each cover keyed by the
 * first position it appears at, so a repeated cover cannot fill two tiles.
 */
export function playlistMosaicCoverColumn(viewer?: string): SQL<string[]> {
  const memberCover = effectiveTrackCoverColumn(
    sql.raw('s.cover_image_id'),
    sql.raw('t.cover_image_id'),
  );
  return sql<string[]>`(
    select coalesce(array_agg(m.cover_image_id order by m.first_position), '{}')
    from (
      select ${memberCover} as cover_image_id, min(pt.position) as first_position
      from ${playlistTracks} pt
      join ${tracks} t on t.id = pt.track_id
      left join ${generationRequests} gr on gr.id = t.generation_request_id
      left join ${activitySessions} s on s.id = gr.activity_session_id
      where pt.playlist_id = ${playlists}."id" and ${memberCover} is not null
        ${visibleMemberCondition(viewer)}
      group by ${memberCover}
      order by first_position
      limit 4
    ) m
  )`;
}

/** Total member playtime in seconds; a member with no known duration counts 0. */
export function playlistTotalDurationColumn(viewer?: string): SQL<number> {
  return sql<number>`(
    select coalesce(sum(coalesce(t.duration_seconds, 0)), 0)::int
    from ${playlistTracks} pt
    join ${tracks} t on t.id = pt.track_id
    where pt.playlist_id = ${playlists}."id" ${visibleMemberCondition(viewer)}
  )`;
}

/**
 * Members the Playlist zip download selects (`getOwnedPlaylistDownloadTracks`):
 * the playlist owner's own Tracks with a servable local final. Shared
 * references and stream-only members count toward `trackCount` but never
 * here, so the download menu rows can stay dark instead of navigating to the
 * route's empty-selection 404 page. Uncapped by `MAX_EXPORT_TRACKS` — the gate
 * only asks whether anything is zippable.
 */
export function playlistDownloadableCountColumn(): SQL<number> {
  return sql<number>`(
    select count(*)::int from ${playlistTracks} pt
    join ${tracks} t on t.id = pt.track_id and t.owner_user_id = ${playlists}."owner_user_id"
    where pt.playlist_id = ${playlists}."id"
      and exists (
        select 1 from ${trackAudioAssets}
        where ${trackAudioAssets}."track_id" = t.id and ${servableLocalFinalConditions()}
      )
  )`;
}

/**
 * Members in no other playlist of this playlist's owner — the "will leave your
 * Library" delete-confirm count. Retention is per owner, so
 * another owner's Shared reference to the same track keeps nothing here.
 */
export function playlistSoleMemberCountColumn(viewer?: string): SQL<number> {
  return sql<number>`(
    select count(*)::int from ${playlistTracks} pt
    join ${tracks} t on t.id = pt.track_id
    where pt.playlist_id = ${playlists}."id" ${visibleMemberCondition(viewer)}
      and ${inNoOtherOwnerPlaylist()}
  )`;
}

/**
 * The sole members the delete removes for good (`orphanedOnceUnsaved`: their
 * Session is gone, so no History holds them) — exactly the Tracks
 * `deletePlaylist` then flips to `deleted`. Only the owner's own Tracks: a
 * Shared reference is never the visitor's to delete.
 */
export function playlistSoleMemberDeletedCountColumn(viewer?: string): SQL<number> {
  return sql<number>`(
    select count(*)::int from ${playlistTracks} pt
    join ${tracks} t on t.id = pt.track_id and t.owner_user_id = ${playlists}."owner_user_id"
    where pt.playlist_id = ${playlists}."id" ${visibleMemberCondition(viewer)}
      and ${inNoOtherOwnerPlaylist()}
      and ${orphanedOnceUnsaved(sql`t`)}
  )`;
}

/** The member row `pt` is in no other playlist of this playlist's owner. */
function inNoOtherOwnerPlaylist(): SQL {
  return sql`not exists (
    select 1 from ${playlistTracks} pt2
    join ${playlists} p2 on p2.id = pt2.playlist_id
    where pt2.track_id = pt.track_id and pt2.playlist_id <> pt.playlist_id
      and p2.owner_user_id = ${playlists}."owner_user_id"
  )`;
}
