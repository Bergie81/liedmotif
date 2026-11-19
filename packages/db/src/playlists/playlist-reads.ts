// The owner's playlist reads: the Playlists tab (full list and keyset page)
// and one playlist's detail page. Owner-scoped like the writes in
// `playlists-repo.ts`: a cross-owner id reads as missing. The card facts come
// from `playlist-summary-columns.ts`, the one definition every surface shares.

import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../client';
import { effectiveTrackCoverColumn } from '../covers/effective-track-cover';
import {
  activitySessions,
  generationRequests,
  listenerProfiles,
  playlists,
  playlistTracks,
  tracks,
  user,
} from '../schema';
import { viewerShelfColumns } from './curated-membership';
import { trackSummaryColumns, type OwnedTrackSummary } from '../generation/feedback-repo';
import { decodeKeysetCursor, encodeKeysetCursor } from '../generation/keyset-cursor';
import {
  playlistDownloadableCountColumn,
  playlistMosaicCoverColumn,
  playlistSoleMemberCountColumn,
  playlistSoleMemberDeletedCountColumn,
  playlistTotalDurationColumn,
  playlistTrackCountColumn,
} from './playlist-summary-columns';
import type { OwnerAttribution } from './owner-attribution';
import type { PlaylistRow } from './playlists-repo';
import { playlistMatchFields, searchBoxCondition } from '../search/match';

export interface PlaylistSummary extends PlaylistRow {
  trackCount: number;
  /** Total member playtime in seconds (unknown durations count 0). */
  totalDurationSeconds: number;
  /** Members the Playlist zip can carry (see `playlistDownloadableCountColumn`). */
  downloadableTrackCount: number;
  /**
   * Up to 4 distinct member cover-image ids in playlist order — the sources of
   * the derived 2x2 mosaic (the default cover; always the fallback).
   */
  mosaicCoverImageIds: string[];
  /** Members whose ONLY playlist is this one (they go Ephemeral on delete). */
  soleMemberTrackCount: number;
  /** The sole members the delete removes for good: their Session is gone, so no History holds them. */
  soleMemberDeletedTrackCount: number;
  /** Membership of the `containsTrackId` passed to the list (the picker read); null when none was. */
  containsTrack: boolean | null;
}

interface PlaylistListFilter {
  ownerUserId: string;
  containsTrackId?: string | null;
  playlistId?: string;
  /** Case-insensitive substring over the playlist match surface (see `playlistMatchFields`). */
  search?: string | null;
}

/** The activity sort key: GREATEST ignores NULLs, so a never-played playlist sorts by updatedAt. */
const playlistActivityExpr = sql`greatest(${playlists.updatedAt}, ${playlists.lastPlayedAt})`;

/** The activity instant as `playlistActivityExpr` computes it, for cursor encoding. */
function playlistActivityAt(row: Pick<PlaylistRow, 'updatedAt' | 'lastPlayedAt'>): Date {
  return row.lastPlayedAt && row.lastPlayedAt > row.updatedAt ? row.lastPlayedAt : row.updatedAt;
}

/**
 * Owner scope + the optional single-playlist and search filters. The search
 * condition uses the shared match vocabulary: the same words here and in
 * /search select the same playlists (the Favorites and Library pin slots and
 * the activity order stay this list's own).
 */
function playlistFilterConditions(filter: PlaylistListFilter): SQL | undefined {
  return and(
    eq(playlists.ownerUserId, filter.ownerUserId),
    filter.playlistId ? eq(playlists.id, filter.playlistId) : undefined,
    searchBoxCondition(playlistMatchFields(), filter.search),
  );
}

/** The shared summary select — every list surface reads the same card facts. */
function playlistSummaryQuery(db: Database, filter: PlaylistListFilter, where?: SQL) {
  const containsTrack = filter.containsTrackId
    ? sql<boolean>`exists(
        select 1 from ${playlistTracks} pt
        where pt.playlist_id = ${playlists}."id" and pt.track_id = ${filter.containsTrackId}
      )`
    : sql<boolean | null>`null::boolean`;
  return db
    .select({
      id: playlists.id,
      ownerUserId: playlists.ownerUserId,
      name: playlists.name,
      kind: playlists.kind,
      listedInPlaylists: playlists.listedInPlaylists,
      coverImageId: playlists.coverImageId,
      lastPlayedAt: playlists.lastPlayedAt,
      sharedAt: playlists.sharedAt,
      pinnedAt: playlists.pinnedAt,
      createdAt: playlists.createdAt,
      updatedAt: playlists.updatedAt,
      trackCount: playlistTrackCountColumn(),
      totalDurationSeconds: playlistTotalDurationColumn(),
      downloadableTrackCount: playlistDownloadableCountColumn(),
      mosaicCoverImageIds: playlistMosaicCoverColumn(),
      soleMemberTrackCount: playlistSoleMemberCountColumn(),
      soleMemberDeletedTrackCount: playlistSoleMemberDeletedCountColumn(),
      containsTrack,
    })
    .from(playlists)
    .where(and(playlistFilterConditions(filter), where));
}

/**
 * The summary projection for an already-chosen page, returned in the given id
 * order. Keeps the per-playlist summary subqueries off the rows a page never
 * shows: callers pick the winning ids with a bare query first.
 */
async function playlistSummariesByIds(
  db: Database,
  filter: PlaylistListFilter,
  ids: string[],
): Promise<PlaylistSummary[]> {
  if (ids.length === 0) return [];
  const rows = await playlistSummaryQuery(db, filter, inArray(playlists.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row) => row !== undefined);
}

/** Favorites, then the Library pins (newest pin first), then by activity. */
const playlistListOrder = [
  sql`case when ${playlists.kind} = 'favorites' then 0 else 1 end`,
  sql`${playlists.pinnedAt} desc nulls last`,
  sql`${playlistActivityExpr} desc`,
  asc(playlists.id),
];

/**
 * List the owner's playlists — Favorites first, then their Library pins, newest
 * pin first, then by most recent activity (membership change or last play) —
 * with live member counts. `listPlaylistsPage` walks this exact order
 * page-by-page (Favorites and the pins via their first-page slot, the other
 * user rows via the keyset) — keep the two in step.
 */
export async function listPlaylists(
  db: Database,
  args: PlaylistListFilter,
): Promise<PlaylistSummary[]> {
  return playlistSummaryQuery(db, args).orderBy(...playlistListOrder);
}

export interface ListPlaylistsPageResult {
  items: PlaylistSummary[];
  nextCursor: string | null;
}

/**
 * One page of the owner's playlists in the `listPlaylists` order. Favorites and
 * the Library pins sit outside the keyset — they ride the FIRST page without
 * counting toward `limit`, however many there are — while the other user
 * playlists page on (activity desc, id asc), so the cursor codec stays the
 * shared `{ t, id }` shape.
 */
export async function listPlaylistsPage(
  db: Database,
  args: Omit<PlaylistListFilter, 'playlistId'> & { cursor?: string | null; limit: number },
): Promise<ListPlaylistsPageResult> {
  const cursor = args.cursor ? decodeKeysetCursor(args.cursor) : null;
  // Page on the bare rows first: the per-playlist summary subqueries run only
  // for the winning page, never for the rows the page discards.
  const baseFilter = playlistFilterConditions(args);
  const firstPageSlots = cursor
    ? []
    : await db
        .select({ id: playlists.id })
        .from(playlists)
        .where(and(baseFilter, or(eq(playlists.kind, 'favorites'), isNotNull(playlists.pinnedAt))))
        .orderBy(...playlistListOrder);
  // After the cursor row under (activity DESC, id ASC): strictly older
  // activity, or the same instant with a higher id.
  const keyset = cursor
    ? sql`(${playlistActivityExpr} < ${cursor.t}::timestamptz
        or (${playlistActivityExpr} = ${cursor.t}::timestamptz and ${playlists.id} > ${cursor.id}::uuid))`
    : undefined;
  const rows = await db
    .select({
      id: playlists.id,
      updatedAt: playlists.updatedAt,
      lastPlayedAt: playlists.lastPlayedAt,
    })
    .from(playlists)
    .where(and(baseFilter, eq(playlists.kind, 'user'), isNull(playlists.pinnedAt), keyset))
    .orderBy(sql`${playlistActivityExpr} desc`, asc(playlists.id))
    .limit(args.limit + 1);

  const hasMore = rows.length > args.limit;
  const page = hasMore ? rows.slice(0, args.limit) : rows;
  const last = page[page.length - 1];
  const items = await playlistSummariesByIds(db, args, [
    ...firstPageSlots.map((row) => row.id),
    ...page.map((row) => row.id),
  ]);
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeKeysetCursor({ t: playlistActivityAt(last).toISOString(), id: last.id })
        : null,
  };
}

export interface PlaylistMemberTrack extends OwnedTrackSummary {
  /** The member's 0-based slot in the playlist's user order. */
  position: number;
  originSessionTitle: string | null;
  /** Set only on a Shared reference: the foreign track's owner.
   *  Null for the reader's own tracks. */
  owner?: OwnerAttribution | null;
}

export interface PlaylistDetailResult {
  playlist: PlaylistSummary;
  items: PlaylistMemberTrack[];
  nextCursor: string | null;
}

/**
 * The position a detail page starts after. A missing or unreadable cursor is
 * the first page; one past the int4 column's range is past every member, never
 * a value Postgres refuses to compare.
 */
export function afterPlaylistPosition(cursor: string | null | undefined): number {
  const position = cursor == null ? -1 : Number.parseInt(cursor, 10);
  return Number.isNaN(position) ? -1 : Math.min(Math.max(position, -1), 2_147_483_647);
}

/**
 * One owned playlist with its members in user order, keyset-paged on position
 * (`cursor` = the last position of the previous page). Null when absent/not
 * owned. A member row may be a Shared reference: it rides the page
 * like any other member, attributed to its owner, with the shelves served as
 * the READER's relationship — the foreign track's own flags never travel.
 */
export async function getPlaylistDetail(
  db: Database,
  args: { ownerUserId: string; playlistId: string; cursor?: string | null; limit: number },
): Promise<PlaylistDetailResult | null> {
  const [playlist] = await listPlaylists(db, {
    ownerUserId: args.ownerUserId,
    playlistId: args.playlistId,
  });
  if (!playlist) return null;

  const rows = await db
    .select({
      ...trackSummaryColumns(db),
      ...viewerShelfColumns(db, args.ownerUserId),
      coverImageId: effectiveTrackCoverColumn(activitySessions.coverImageId, tracks.coverImageId),
      originSessionTitle: activitySessions.title,
      position: playlistTracks.position,
      trackOwnerUserId: tracks.ownerUserId,
      trackOwnerName: user.name,
      trackOwnerArtistName: listenerProfiles.artistName,
      trackOwnerImageUrl: user.image,
    })
    .from(playlistTracks)
    .innerJoin(tracks, eq(tracks.id, playlistTracks.trackId))
    .leftJoin(generationRequests, eq(generationRequests.id, tracks.generationRequestId))
    .leftJoin(activitySessions, eq(activitySessions.id, generationRequests.activitySessionId))
    .leftJoin(user, eq(user.id, tracks.ownerUserId))
    .leftJoin(listenerProfiles, eq(listenerProfiles.ownerUserId, tracks.ownerUserId))
    .where(
      and(
        eq(playlistTracks.playlistId, playlist.id),
        gt(playlistTracks.position, afterPlaylistPosition(args.cursor)),
      ),
    )
    .orderBy(asc(playlistTracks.position))
    .limit(args.limit + 1);

  const hasMore = rows.length > args.limit;
  const page = hasMore ? rows.slice(0, args.limit) : rows;
  const items: PlaylistMemberTrack[] = page.map(
    ({ trackOwnerUserId, trackOwnerName, trackOwnerArtistName, trackOwnerImageUrl, ...row }) => ({
      ...row,
      hasPlayableAudio: row.hasPlayableAudio ?? false,
      hasFinalAsset: row.hasFinalAsset ?? false,
      owner:
        trackOwnerUserId === args.ownerUserId
          ? null
          : {
              name: trackOwnerName ?? '',
              artistName: trackOwnerArtistName,
              imageUrl: trackOwnerImageUrl,
            },
    }),
  );
  const last = page[page.length - 1];
  return {
    playlist,
    items,
    nextCursor: hasMore && last ? String(last.position) : null,
  };
}
