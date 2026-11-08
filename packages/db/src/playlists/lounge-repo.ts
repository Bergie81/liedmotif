// The Lounge listing: every non-empty playlist in the
// Lounge for the viewer — shared with everyone, shared with them by name, or
// their own — across all owners, attributed to its owner: the viewer's Pins
// first (newest pin first), then newest-shared first. Visibility is the one
// per-viewer predicate (`playlistLoungeVisibleTo`); "Yours" is presentation the
// route derives, never a filter. Empty In-Lounge playlists stay shared but
// unlisted (no dead entries), pinned or not.
//
// The search box narrows this one listing (filter semantics, never a
// re-rank): the shared match vocabulary decides WHETHER a row stays and which
// field gets named on it, while the order stays Pins-then-newest-shared.

import { and, asc, desc, eq, gt, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import type { SearchMatchField } from '@liedmotif/shared';
import type { Database } from '../client';
import { effectiveTrackCoverColumn } from '../covers/effective-track-cover';
import { trackSummaryColumns } from '../generation/feedback-repo';
import { decodeKeysetCursor, encodeKeysetCursor } from '../generation/keyset-cursor';
import {
  activitySessions,
  generationRequests,
  listenerProfiles,
  playlistPins,
  playlists,
  playlistTracks,
  tracks,
  user,
} from '../schema';
import {
  playlistLoungeVisibleTo,
  playlistMemberVisibleTo,
  viewerCanReadTrack,
} from './lounge-audible';
import {
  ownerAttributionColumns,
  ownerDisplayNameOrder,
  type OwnerAttribution,
} from './owner-attribution';
import { viewerShelfColumns } from './curated-membership';
import {
  buildMatchPatterns,
  fieldScore,
  fieldText,
  loungeMatchFields,
  matchCondition,
  winningMatchIndex,
  type MatchFieldDef,
  type MatchPatterns,
} from '../search/match';
import { cutSnippet } from '../search/snippet';
import {
  playlistHasMembersCondition,
  playlistMosaicCoverColumn,
  playlistTotalDurationColumn,
  playlistTrackCountColumn,
  type PlaylistMemberTrack,
  type PlaylistSummary,
} from './playlists-repo';

/** Why a row survived the query: the winning field and a bounded snippet of it. */
export interface LoungeMatch {
  field: SearchMatchField;
  snippet: string;
}

/** A sharing owner as every Lounge read names them: the shared attribution
 *  plus the id the member filter and the per-viewer "Yours" derivation key on. */
export interface LoungeOwner extends OwnerAttribution {
  userId: string;
}

export interface LoungePlaylistRow {
  id: string;
  name: string;
  coverImageId: string | null;
  mosaicCoverImageIds: string[];
  trackCount: number;
  totalDurationSeconds: number;
  /** The share instant — the Lounge's newest-first sort key (never null here). */
  sharedAt: Date;
  /** Whether the viewer pinned it. */
  pinned: boolean;
  owner: LoungeOwner;
  /** Present iff the page was narrowed by a query. */
  match: LoungeMatch | null;
}

export interface ListLoungePlaylistsPageResult {
  items: LoungePlaylistRow[];
  nextCursor: string | null;
}

/**
 * One page of the Lounge. The viewer's Pins sit outside the keyset — they ride
 * the FIRST page, newest pin first, without counting toward `limit`, however
 * many there are — while the other entries page on (sharedAt DESC, id ASC) with
 * the shared `{ t, id }` cursor codec. Reuses the owner grid's summary columns
 * so a playlist's card facts cannot diverge between the Lounge and the Library.
 *
 * `query` and `ownerUserId` compose as filters over the same listing: a track
 * or tag hit keeps every containing shared playlist, sung lyrics never match,
 * and the order is untouched.
 */
export async function listLoungePlaylistsPage(
  db: Database,
  args: {
    /** Whose Lounge this is — only playlists visible to them are listed. */
    viewerUserId: string;
    cursor?: string | null;
    limit: number;
    /** Narrow to entries matching the Lounge vocabulary (blank = everything). */
    query?: string | null;
    /** Narrow to one sharing owner (the member filter). */
    ownerUserId?: string | null;
  },
): Promise<ListLoungePlaylistsPageResult> {
  const query = args.query?.trim() ?? '';
  const patterns = query ? buildMatchPatterns(query) : null;
  const viewer = args.viewerUserId;
  const defs = loungeMatchFields(viewer);

  const cursor = args.cursor ? decodeKeysetCursor(args.cursor) : null;
  const keyset = cursor
    ? sql`(${playlists.sharedAt} < ${cursor.t}::timestamptz
        or (${playlists.sharedAt} = ${cursor.t}::timestamptz and ${playlists.id} > ${cursor.id}::uuid))`
    : undefined;

  const listed = and(
    playlistLoungeVisibleTo(viewer),
    playlistHasMembersCondition(viewer),
    args.ownerUserId ? eq(playlists.ownerUserId, args.ownerUserId) : undefined,
    patterns ? matchCondition(defs, patterns) : undefined,
  );
  const viewerPin = and(
    eq(playlistPins.playlistId, playlists.id),
    eq(playlistPins.visitorUserId, viewer),
  );
  const selectLoungeEntries = () =>
    db
      .select({
        id: playlists.id,
        name: playlists.name,
        coverImageId: playlists.coverImageId,
        mosaicCoverImageIds: playlistMosaicCoverColumn(viewer),
        trackCount: playlistTrackCountColumn(viewer),
        totalDurationSeconds: playlistTotalDurationColumn(viewer),
        sharedAt: playlists.sharedAt,
        pinned: sql<boolean>`${playlistPins.id} is not null`,
        owner: { userId: playlists.ownerUserId, ...ownerAttributionColumns() },
        ...(patterns ? matchColumns(defs, patterns) : {}),
      })
      .from(playlists)
      .innerJoin(user, eq(user.id, playlists.ownerUserId))
      .leftJoin(listenerProfiles, eq(listenerProfiles.ownerUserId, playlists.ownerUserId))
      .leftJoin(playlistPins, viewerPin);

  const pinned = cursor
    ? []
    : await selectLoungeEntries()
        .where(and(listed, isNotNull(playlistPins.id)))
        .orderBy(desc(playlistPins.createdAt), asc(playlists.id));
  const rows = await selectLoungeEntries()
    .where(and(listed, isNull(playlistPins.id), keyset))
    .orderBy(desc(playlists.sharedAt), asc(playlists.id))
    .limit(args.limit + 1);

  const hasMore = rows.length > args.limit;
  const page = hasMore ? rows.slice(0, args.limit) : rows;
  const toItem = (row: (typeof rows)[number]): LoungePlaylistRow => ({
    ...(row as unknown as Omit<LoungePlaylistRow, 'match'>),
    match: patterns ? rowMatch(row as Record<string, unknown>, defs, query) : null,
  });
  const pageItems = page.map(toItem);
  const last = pageItems[pageItems.length - 1];
  return {
    items: [...pinned.map(toItem), ...pageItems],
    nextCursor:
      hasMore && last ? encodeKeysetCursor({ t: last.sharedAt.toISOString(), id: last.id }) : null,
  };
}

/** Per-def score/text projections, keyed s0/t0… in definition order. */
function matchColumns(defs: MatchFieldDef[], patterns: MatchPatterns): Record<string, SQL> {
  const columns: Record<string, SQL> = {};
  defs.forEach((def, i) => {
    columns[`s${i}`] = fieldScore(def, patterns);
    columns[`t${i}`] = fieldText(def, patterns);
  });
  return columns;
}

/**
 * The row's winning field, read back from the s/t aliases. A row can only be
 * here because `matchCondition` held, but SQL and JS lowercasing can disagree
 * on exotic collation — a scoreless row degrades to null rather than throwing.
 */
function rowMatch(
  row: Record<string, unknown>,
  defs: MatchFieldDef[],
  query: string,
): LoungeMatch | null {
  const winner = winningMatchIndex(defs.map((_, i) => row[`s${i}`] as number | null));
  if (winner < 0) return null;
  return {
    field: defs[winner]!.field,
    snippet: cutSnippet(String(row[`t${winner}`] ?? ''), query),
  };
}

/** A sharing owner as their Lounge profile card shows them. */
export interface LoungeSharerRow extends LoungeOwner {
  /** The profile's short self-description; null when unset. */
  description: string | null;
  /** Distinct tracks the viewer can see across this owner's playlists in their
   *  Lounge — a track in two of those playlists counts once. */
  sharedTrackCount: number;
}

/**
 * Every owner with at least one playlist listable for the viewer (non-empty,
 * visible to them) — the member filter's inventory, display-name ordered.
 * The viewer-first "You" move is presentation, not a query concern.
 *
 * Members are joined through the same member gate the tile counts compose
 * (`playlistMemberVisibleTo`), so an owner is listed exactly when one of
 * their visible playlists has a visible member, and the count can never
 * exceed what the tiles add up to.
 */
export async function listLoungeSharers(
  db: Database,
  args: { viewerUserId: string },
): Promise<LoungeSharerRow[]> {
  return db
    .select({
      userId: user.id,
      ...ownerAttributionColumns(),
      description: listenerProfiles.description,
      sharedTrackCount: sql<number>`count(distinct ${tracks.id})::int`,
    })
    .from(playlists)
    .innerJoin(user, eq(user.id, playlists.ownerUserId))
    .leftJoin(listenerProfiles, eq(listenerProfiles.ownerUserId, playlists.ownerUserId))
    .innerJoin(playlistTracks, eq(playlistTracks.playlistId, playlists.id))
    .innerJoin(tracks, eq(tracks.id, playlistTracks.trackId))
    .where(
      and(
        playlistLoungeVisibleTo(args.viewerUserId),
        playlistMemberVisibleTo(args.viewerUserId, sql`${tracks}`),
      ),
    )
    .groupBy(
      user.id,
      user.name,
      listenerProfiles.artistName,
      listenerProfiles.description,
      user.image,
    )
    .orderBy(...ownerDisplayNameOrder());
}

export interface LoungePlaylistDetailResult {
  playlist: PlaylistSummary;
  owner: LoungeOwner;
  items: PlaylistMemberTrack[];
  nextCursor: string | null;
}

/**
 * One playlist in the Lounge for a Visitor: attributed summary plus its members
 * in the owner's order, keyset-paged on position exactly like the owner's
 * detail read. Null when the id is unknown, private, revoked, or shared with
 * selected Users that exclude the viewer — indistinguishable, the callers'
 * uniform 404.
 *
 * Members compose the one audibility predicate (`viewerCanReadTrack`); the
 * summary's count, playtime, and mosaic compose the member gate
 * (`playlistMemberVisibleTo`), which selects the same rows for a playlist in
 * the viewer's Lounge. A member the visitor could not hear — a reference to a
 * track whose own owner is not sharing it with them — is invisible here AND
 * uncounted, so the client's "more remains" arithmetic never waits on pages
 * that cannot come.
 */
export async function getLoungePlaylistDetail(
  db: Database,
  args: { viewerUserId: string; playlistId: string; cursor?: string | null; limit: number },
): Promise<LoungePlaylistDetailResult | null> {
  const [row] = await db
    .select({
      id: playlists.id,
      ownerUserId: playlists.ownerUserId,
      name: playlists.name,
      kind: playlists.kind,
      listedInPlaylists: playlists.listedInPlaylists,
      coverImageId: playlists.coverImageId,
      lastPlayedAt: playlists.lastPlayedAt,
      sharedAt: playlists.sharedAt,
      createdAt: playlists.createdAt,
      updatedAt: playlists.updatedAt,
      trackCount: playlistTrackCountColumn(args.viewerUserId),
      totalDurationSeconds: playlistTotalDurationColumn(args.viewerUserId),
      mosaicCoverImageIds: playlistMosaicCoverColumn(args.viewerUserId),
      owner: { userId: playlists.ownerUserId, ...ownerAttributionColumns() },
    })
    .from(playlists)
    .innerJoin(user, eq(user.id, playlists.ownerUserId))
    .leftJoin(listenerProfiles, eq(listenerProfiles.ownerUserId, playlists.ownerUserId))
    .where(and(eq(playlists.id, args.playlistId), playlistLoungeVisibleTo(args.viewerUserId)))
    .limit(1);
  if (!row) return null;

  const afterPosition = args.cursor == null ? -1 : Number.parseInt(args.cursor, 10);
  const memberRows = await db
    .select({
      ...trackSummaryColumns(db),
      // The owner's retention shelves are Library facts, not track facts — the
      // visitor sees their OWN relationship to each member (their Shared
      // references light the shelves), never the owner's flags.
      ...viewerShelfColumns(db, args.viewerUserId),
      coverImageId: effectiveTrackCoverColumn(activitySessions.coverImageId, tracks.coverImageId),
      originSessionTitle: activitySessions.title,
      position: playlistTracks.position,
    })
    .from(playlistTracks)
    .innerJoin(tracks, eq(tracks.id, playlistTracks.trackId))
    .leftJoin(generationRequests, eq(generationRequests.id, tracks.generationRequestId))
    .leftJoin(activitySessions, eq(activitySessions.id, generationRequests.activitySessionId))
    .where(
      and(
        eq(playlistTracks.playlistId, row.id),
        gt(playlistTracks.position, Number.isNaN(afterPosition) ? -1 : afterPosition),
        viewerCanReadTrack(args.viewerUserId),
      ),
    )
    .orderBy(asc(playlistTracks.position))
    .limit(args.limit + 1);

  const hasMore = memberRows.length > args.limit;
  const page = hasMore ? memberRows.slice(0, args.limit) : memberRows;
  const items: PlaylistMemberTrack[] = page.map((member) => ({
    ...member,
    hasPlayableAudio: member.hasPlayableAudio ?? false,
    hasFinalAsset: member.hasFinalAsset ?? false,
  }));
  const last = page[page.length - 1];
  const { owner, ...playlist } = row;
  return {
    // A visitor never downloads another owner's playlist.
    playlist: {
      ...playlist,
      downloadableTrackCount: 0,
      soleMemberTrackCount: 0,
      containsTrack: null,
      // A Library pin is the owner's alone; a visitor never sees one.
      pinnedAt: null,
    },
    owner,
    items,
    nextCursor: hasMore && last ? String(last.position) : null,
  };
}
