// Ranked, capped retrieval over Sessions, Tracks and Playlists.
// Rank runs in SQL — `ORDER BY score, createdAt desc, id` over the shared
// match vocabulary — so only winning rows leave the database, and every row
// carries the (field, exactness) pair that won it its place plus an exact
// `count(*) over ()` of all matches, independent of the cap.

import { eq, inArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { SearchMatchField, SearchSort } from '@liedmotif/shared';
import type { Database } from '../client';
import { libraryColumns, type LibraryTrack } from '../generation/feedback-repo';
import { sessionLastActiveExpr, sessionNotPendingDelete } from '../generation/session-list-repo';
import {
  playlistDownloadableCountColumn,
  playlistMosaicCoverColumn,
  playlistSoleMemberCountColumn,
  playlistSoleMemberDeletedCountColumn,
  playlistTotalDurationColumn,
  playlistTrackCountColumn,
} from '../playlists/playlist-summary-columns';
import type { PlaylistSummary } from '../playlists/playlists-repo';
import { viewerCanSearchPlaylist } from '../playlists/lounge-audible';
import { ownerAttributionColumns, type OwnerAttribution } from '../playlists/owner-attribution';
import {
  activitySessions,
  generationRequests,
  listenerProfiles,
  playlists,
  tracks,
  user,
} from '../schema';
import {
  buildMatchPatterns,
  exactnessFromScore,
  fieldScore,
  fieldText,
  lyricsMatchFields,
  matchCondition,
  memberTitleMatchCount,
  playlistMatchFields,
  sessionMatchFields,
  trackMatchFields,
  type MatchFieldDef,
} from './match';
import { cutSnippet } from './snippet';

export type { SearchSort } from '@liedmotif/shared';

export interface SearchArgs {
  ownerUserId: string;
  /** Already trimmed, at least 2 characters. */
  query: string;
  limit: number;
  sort: SearchSort;
}

export interface SearchMatch {
  /** The single winning field the match-context line names. */
  field: SearchMatchField;
  /**
   * 0 = whole field … 3 = anywhere, 4 = genre tag with punctuation ignored; the
   * tier the rank ordered by.
   */
  exactness: number;
  /** Bounded display window around the first hit in the winning field. */
  snippet: string;
}

export interface SearchGroup<T> {
  items: T[];
  /** Exact number of matching rows, independent of the cap. */
  matchCount: number;
}

export interface SearchTrackHit extends LibraryTrack {
  match: SearchMatch;
}

export interface SearchSessionHit {
  id: string;
  title: string | null;
  coverImageId: string | null;
  status: 'active' | 'stopped';
  pinned: boolean;
  lastActiveAt: Date;
  createdAt: Date;
  match: SearchMatch;
}

export interface SearchPlaylistHit extends PlaylistSummary {
  /** How many member track titles matched the query. */
  memberMatchCount: number;
  /** Set only on a Lounge-pinned foreign playlist: the sharing owner's
   *  attribution. Null on the viewer's own rows. */
  owner: OwnerAttribution | null;
  match: SearchMatch;
}

interface RankedRow extends Record<string, unknown> {
  matchField: SearchMatchField;
  matchText: string | null;
  matchExactness: number;
  matchCount: number;
}

/** One kind's ranked search: the row it projects, where it comes from, how it matches. */
interface RankedSearch {
  args: SearchArgs;
  /** The row's projection, keyed by the camelCase alias its mapper reads back. */
  columns: Record<string, SQLWrapper>;
  /** `from` + the joins the projection needs — no `where`. */
  from: SQL;
  /** Eligibility conditions (owner scope included). */
  where: SQL;
  defs: MatchFieldDef[];
  /** The alias Title A–Z orders by (`title` / `name`). */
  titleAlias: string;
}

function joinCommas(parts: SQL[]): SQL {
  return sql.join(parts, sql`, `);
}

/** A projection alias, quoted so Postgres keeps its camelCase spelling. */
function quotedAlias(alias: string): SQL {
  return sql.raw(`"${alias}"`);
}

/** The projection as `expr as "alias"`, in declaration order. */
function aliasedColumns(columns: Record<string, SQLWrapper>): SQL {
  return joinCommas(
    Object.entries(columns).map(([alias, column]) => sql`${column} as ${quotedAlias(alias)}`),
  );
}

/** The per-field score and winning-text aliases the `matched` CTE projects. */
function scoreAlias(index: number): SQL {
  return sql.raw(`s${index}`);
}

function textAlias(index: number): SQL {
  return sql.raw(`t${index}`);
}

/**
 * A CASE picking the arm of whichever field's score won. Ties on the winning
 * score share (exactness, weight); listing arms in definition order makes the
 * reported field deterministic anyway.
 */
function winningArm(defs: MatchFieldDef[], arm: (def: MatchFieldDef, index: number) => SQL): SQL {
  return sql`case ${sql.join(
    defs.map((def, i) => sql`when score = ${scoreAlias(i)} then ${arm(def, i)}`),
    sql` `,
  )} end`;
}

/**
 * The shared query shape: score every field of every eligible row, pick the
 * winner with `least(...)`, filter to matches, count them all, and cap.
 *
 * Ranking runs over the match expressions alone (id + sort keys + scores);
 * the projection — which carries correlated probes and per-playlist summary
 * subqueries — joins onto only the ≤limit survivors. `count(*) over ()` sits
 * inside the capped CTE, before the limit, so `matchCount` stays exact.
 *
 * The WHERE also carries `matchCondition` as an eligibility prefilter: it
 * selects the same rows a non-null score would, but runs BEFORE the projection,
 * so a non-matching row never pays for the scoring expressions. Never gate it on
 * query length — under three characters there are no trigrams to index with, and
 * the rank still scores those queries.
 */
function rankedQuery(spec: RankedSearch): SQL {
  const patterns = buildMatchPatterns(spec.args.query);
  const scoreColumns = joinCommas(
    spec.defs.map(
      (def, i) =>
        sql`${fieldScore(def, patterns)} as ${scoreAlias(i)}, ${fieldText(def, patterns)} as ${textAlias(i)}`,
    ),
  );
  const best = sql`least(${joinCommas(spec.defs.map((_, i) => scoreAlias(i)))})`;
  const order = orderBy(spec.args.sort, spec.titleAlias);
  const sortKeys = joinCommas(
    sortKeyAliases(spec.titleAlias).map(
      (alias) => sql`${spec.columns[alias]} as ${quotedAlias(alias)}`,
    ),
  );
  return sql`
    with matched as (
      select ${spec.columns.id} as id, ${sortKeys}, ${scoreColumns}
      ${spec.from}
      where ${spec.where} and ${matchCondition(spec.defs, patterns)}
    ),
    ranked as (
      select *, ${best} as score from matched
    ),
    winners as (
      select *, count(*) over ()::int as "matchCount"
      from ranked
      where score is not null
      order by ${order}
      limit ${spec.args.limit}
    )
    select ${aliasedColumns(spec.columns)},
      ${winningArm(spec.defs, (def) => sql`${def.field}`)} as "matchField",
      ${winningArm(spec.defs, (_, i) => textAlias(i))} as "matchText",
      ${exactnessFromScore(sql`score`)} as "matchExactness",
      winners."matchCount"
    ${spec.from}
    join winners on winners.id = ${spec.columns.id}
    order by ${order}
  `;
}

/**
 * Runs one kind's ranked query into a capped group: every row is handed the
 * match that won it its place, and the count is the pre-cap total.
 */
async function runRankedSearch<Row extends RankedRow, Hit>(
  db: Database,
  spec: RankedSearch,
  toHit: (row: Row, match: SearchMatch) => Hit,
): Promise<SearchGroup<Hit>> {
  // Raw execute is typed per call, not per row shape: the projection each
  // caller passed in is what its own mapper reads back.
  const result = await db.execute<RankedRow>(rankedQuery(spec));
  return {
    items: result.rows.map((row) => toHit(row as Row, toMatch(row, spec.args.query))),
    matchCount: result.rows[0]?.matchCount ?? 0,
  };
}

/**
 * The projection aliases `orderBy` may reference besides `score` and `id` —
 * the ranking CTE projects exactly these, so a new sort permutation must add
 * its key here to be orderable before the winners join.
 */
function sortKeyAliases(titleAlias: string): string[] {
  return ['createdAt', titleAlias];
}

function orderBy(sort: SearchSort, titleAlias: string): SQL {
  switch (sort) {
    case 'relevance':
      return sql`score asc, "createdAt" desc, id asc`;
    case 'newest':
      return sql`"createdAt" desc, id asc`;
    case 'title':
      return sql`${quotedAlias(titleAlias)} asc nulls last, id asc`;
  }
}

function toMatch(row: RankedRow, query: string): SearchMatch {
  return {
    field: row.matchField,
    exactness: row.matchExactness,
    snippet: cutSnippet(row.matchText ?? '', query),
  };
}

// Raw `db.execute` rows carry timestamptz values as strings (only the query
// builder maps them to Date), so every timestamp is normalized here.
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toNullableDate(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value);
}

interface TrackHitRow extends RankedRow {
  id: string;
  title: string | null;
  generatedArtistName: string | null;
  status: LibraryTrack['status'];
  durationSeconds: number | null;
  coverImageId: string | null;
  savedAt: Date | string | null;
  favoritedAt: Date | string | null;
  dislikedAt: Date | string | null;
  inCuratedPlaylist: boolean;
  genreTags: string[];
  vocalMode: LibraryTrack['vocalMode'];
  hasLyrics: boolean;
  hasPlayableAudio: boolean | null;
  hasFinalAsset: boolean | null;
  createdAt: Date | string;
  hasPlayed: boolean;
  originSessionId: string | null;
  originSessionTitle: string | null;
}

function toTrackHit(row: TrackHitRow, match: SearchMatch): SearchTrackHit {
  return {
    id: row.id,
    title: row.title,
    generatedArtistName: row.generatedArtistName,
    status: row.status,
    durationSeconds: row.durationSeconds,
    coverImageId: row.coverImageId,
    savedAt: toNullableDate(row.savedAt),
    favoritedAt: toNullableDate(row.favoritedAt),
    dislikedAt: toNullableDate(row.dislikedAt),
    inCuratedPlaylist: row.inCuratedPlaylist,
    genreTags: row.genreTags,
    vocalMode: row.vocalMode,
    hasLyrics: row.hasLyrics,
    hasPlayableAudio: row.hasPlayableAudio ?? false,
    hasFinalAsset: row.hasFinalAsset ?? false,
    createdAt: toDate(row.createdAt),
    hasPlayed: row.hasPlayed,
    originSessionId: row.originSessionId,
    originSessionTitle: row.originSessionTitle,
    match,
  };
}

/** The Tracks a search may hand their owner. */
export function searchableTracks(ownerUserId: string): SQL {
  return sql`${tracks.ownerUserId} = ${ownerUserId}
    and ${tracks.status} not in ('rejected', 'deleted')`;
}

/** The Sessions a search may hand their owner. */
export function searchableSessions(ownerUserId: string): SQL {
  return sql`${activitySessions.ownerUserId} = ${ownerUserId} and ${sessionNotPendingDelete()}`;
}

export async function searchTracks(
  db: Database,
  args: SearchArgs & {
    /** Lyrics mode: match sung lyric text alone (tracks without lyrics are absent). */
    lyricsOnly?: boolean;
  },
): Promise<SearchGroup<SearchTrackHit>> {
  return runRankedSearch(
    db,
    {
      args,
      // The canonical Library projection, so a track's row facts cannot diverge
      // between the Library and search.
      columns: libraryColumns(db),
      from: sql`
        from ${tracks}
        left join ${generationRequests} on ${generationRequests.id} = ${tracks.generationRequestId}
        left join ${activitySessions}
          on ${activitySessions.id} = ${generationRequests.activitySessionId}
          and ${activitySessions.ownerUserId} = ${args.ownerUserId}
      `,
      where: searchableTracks(args.ownerUserId),
      defs: args.lyricsOnly ? lyricsMatchFields() : trackMatchFields(),
      titleAlias: 'title',
    },
    toTrackHit,
  );
}

interface SessionHitRow extends RankedRow {
  id: string;
  title: string | null;
  coverImageId: string | null;
  status: 'active' | 'stopped';
  pinned: boolean;
  lastActiveAt: Date | string;
  createdAt: Date | string;
}

function toSessionHit(row: SessionHitRow, match: SearchMatch): SearchSessionHit {
  return {
    id: row.id,
    title: row.title,
    coverImageId: row.coverImageId,
    status: row.status,
    pinned: row.pinned,
    lastActiveAt: toDate(row.lastActiveAt),
    createdAt: toDate(row.createdAt),
    match,
  };
}

export async function searchSessions(
  db: Database,
  args: SearchArgs,
): Promise<SearchGroup<SearchSessionHit>> {
  return runRankedSearch(
    db,
    {
      args,
      columns: {
        id: activitySessions.id,
        title: activitySessions.title,
        coverImageId: activitySessions.coverImageId,
        status: activitySessions.status,
        pinned: sql`${activitySessions.pinnedAt} is not null`,
        lastActiveAt: sql`coalesce(${sessionLastActiveExpr}, ${activitySessions.createdAt})`,
        createdAt: activitySessions.createdAt,
      },
      from: sql`from ${activitySessions}`,
      where: searchableSessions(args.ownerUserId),
      defs: sessionMatchFields(),
      titleAlias: 'title',
    },
    toSessionHit,
  );
}

interface PlaylistHitRow extends RankedRow {
  id: string;
  ownerUserId: string;
  name: string;
  kind: 'user' | 'favorites';
  listedInPlaylists: boolean;
  coverImageId: string | null;
  lastPlayedAt: Date | string | null;
  sharedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  trackCount: number;
  totalDurationSeconds: number;
  downloadableTrackCount: number;
  mosaicCoverImageIds: string[];
  soleMemberTrackCount: number;
  soleMemberDeletedTrackCount: number;
  memberMatchCount: number;
}

function toPlaylistHit(row: PlaylistHitRow, match: SearchMatch): SearchPlaylistHit {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    kind: row.kind,
    listedInPlaylists: row.listedInPlaylists,
    coverImageId: row.coverImageId,
    lastPlayedAt: toNullableDate(row.lastPlayedAt),
    sharedAt: toNullableDate(row.sharedAt),
    // Search ranks by match and shows no pin state, and a Library pin on a
    // Lounge-pinned foreign row is its owner's alone — so hits never carry one.
    pinnedAt: null,
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
    trackCount: row.trackCount,
    totalDurationSeconds: row.totalDurationSeconds,
    downloadableTrackCount: row.downloadableTrackCount,
    mosaicCoverImageIds: row.mosaicCoverImageIds,
    soleMemberTrackCount: row.soleMemberTrackCount,
    soleMemberDeletedTrackCount: row.soleMemberDeletedTrackCount,
    containsTrack: null,
    memberMatchCount: row.memberMatchCount,
    owner: null,
    match,
  };
}

/**
 * Attach the sharing owner's attribution to the Lounge-pinned (foreign) rows
 * among a viewer's Playlists, where they rank among the viewer's own — a
 * foreign row is always visibly foreign.
 */
export async function attributeForeignPlaylists<
  Item extends { ownerUserId: string; owner: OwnerAttribution | null },
>(db: Database, viewerUserId: string, items: Item[]): Promise<Item[]> {
  const foreignOwnerIds = [
    ...new Set(items.filter((i) => i.ownerUserId !== viewerUserId).map((i) => i.ownerUserId)),
  ];
  if (foreignOwnerIds.length === 0) return items;
  const owners = await db
    .select({ id: user.id, ...ownerAttributionColumns() })
    .from(user)
    .leftJoin(listenerProfiles, eq(listenerProfiles.ownerUserId, user.id))
    .where(inArray(user.id, foreignOwnerIds));
  const byId = new Map(owners.map((o) => [o.id, o]));
  return items.map((item) => {
    if (item.ownerUserId === viewerUserId) return item;
    const owner = byId.get(item.ownerUserId);
    return {
      ...item,
      owner: {
        name: owner?.name ?? '',
        artistName: owner?.artistName ?? null,
        imageUrl: owner?.imageUrl ?? null,
      },
    };
  });
}

export async function searchPlaylists(
  db: Database,
  args: SearchArgs,
): Promise<SearchGroup<SearchPlaylistHit>> {
  // Unlike `listPlaylists`, Favorites is NOT pinned first: rank (or the chosen
  // sort) alone decides the order of search results.
  const viewer = args.ownerUserId;
  const group = await runRankedSearch(
    db,
    {
      args,
      columns: {
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
        trackCount: playlistTrackCountColumn(viewer),
        totalDurationSeconds: playlistTotalDurationColumn(viewer),
        downloadableTrackCount: playlistDownloadableCountColumn(),
        mosaicCoverImageIds: playlistMosaicCoverColumn(viewer),
        soleMemberTrackCount: playlistSoleMemberCountColumn(viewer),
        soleMemberDeletedTrackCount: playlistSoleMemberDeletedCountColumn(viewer),
        memberMatchCount: memberTitleMatchCount(buildMatchPatterns(args.query).anywhere, viewer),
      },
      from: sql`from ${playlists}`,
      // The viewer's own playlists plus the foreign ones they pinned in the
      // Lounge, while still shared with them, ride one ranked group.
      where: viewerCanSearchPlaylist(args.ownerUserId),
      defs: playlistMatchFields(viewer),
      titleAlias: 'name',
    },
    toPlaylistHit,
  );
  // The delete counts read the sharing owner's other playlists and Sessions,
  // which a visitor never sees (as the Lounge read zeroes them).
  const items = group.items.map((item) =>
    item.ownerUserId === viewer
      ? item
      : { ...item, soleMemberTrackCount: 0, soleMemberDeletedTrackCount: 0 },
  );
  return { ...group, items: await attributeForeignPlaylists(db, args.ownerUserId, items) };
}
