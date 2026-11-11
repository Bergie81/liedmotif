// Personal listening analytics: the one reporting command every
// playback surface writes through, and the owner-scoped read behind Your stats.
//
// Independent of `playback_events`, Session heartbeats, and Buffer gates: a
// report here never touches a Session, and a failure here is the caller's to ignore.

import { and, eq, sql, type SQL } from 'drizzle-orm';
import {
  DAILY_LISTENING_LIMIT,
  LISTENING_RANGE_DAYS,
  limitWindowStarts,
  type ListeningOrigin,
  type ListeningRange,
  type ListeningSurface,
} from '@liedmotif/shared';
import type { Database } from '../client';
import { effectiveTrackCoverColumn } from '../covers/effective-track-cover';
import {
  activitySessions,
  generationRequests,
  listeningOccurrences,
  listeningPreferences,
  tracks,
  user,
  USER_SETTINGS_KEYS,
  type ListeningTimeBuckets,
} from '../schema';
import { sessionNotPendingDelete } from '../generation/session-list-repo';
import { readUserSetting, writeUserSetting } from '../settings/user-settings-repo';
import { withTransaction, type DbOrTx } from '../transactions';

const BUCKET_MS = 15 * 60_000;
const PLAY_THRESHOLD_MS = 30_000;
const SHORT_TRACK_SECONDS = 60;
/** Tolerated disagreement between the client's clock and ours, and its rounding. */
const CLOCK_SKEW_MS = 5 * 60_000;
const ELAPSED_SLACK_MS = 5_000;
/** An occurrence older than this is refused rather than allowed to rewrite old days. */
const MAX_OCCURRENCE_AGE_MS = 48 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** Credited time that makes a play: 30 s, or half of a known duration under a minute. */
function playThresholdMs(durationSeconds: number | null): number {
  if (durationSeconds !== null && durationSeconds > 0 && durationSeconds < SHORT_TRACK_SECONDS) {
    return (durationSeconds * 1000) / 2;
  }
  return PLAY_THRESHOLD_MS;
}

/**
 * The sung language of a `tracks` row, as analytics freezes it: the one its
 * generating style detected, which no Track column carries.
 */
export function trackLanguage(): SQL<string | null> {
  return sql<string | null>`(
    select nullif(btrim(${generationRequests.styleSnapshot}->>'language'), '')
    from ${generationRequests} where ${generationRequests.id} = ${tracks.generationRequestId}
  )`;
}

/**
 * A row's `genre_tags` as the genre vocabulary matches them: distinct,
 * `lower(btrim(..))`, blanks dropped. Listening and taste must split a Track's
 * credit across exactly the same set.
 */
export function normalizedGenreTags(tags: SQL): SQL<string[]> {
  return sql`array(
    select distinct lower(btrim(raw.tag))
    from jsonb_array_elements_text(${tags}) as raw(tag)
    where btrim(raw.tag) <> ''
  )`;
}

/** Spread `[endMs - deltaMs, endMs)` over the 15-minute buckets it crosses. */
function allocate(buckets: ListeningTimeBuckets, endMs: number, deltaMs: number) {
  const next = { ...buckets };
  let cursor = endMs - deltaMs;
  while (cursor < endMs) {
    const bucket = Math.floor(cursor / BUCKET_MS);
    const sliceEnd = Math.min(endMs, (bucket + 1) * BUCKET_MS);
    next[bucket] = (next[bucket] ?? 0) + (sliceEnd - cursor);
    cursor = sliceEnd;
  }
  return next;
}

export interface RecordListeningInput {
  ownerUserId: string;
  occurrenceId: string;
  trackId: string;
  sessionId: string | null;
  surface: ListeningSurface;
  /** When this occurrence began, by the client's clock. */
  startedAt: Date;
  origin: ListeningOrigin;
  /** Cumulative credited listening for the occurrence; only ever grows. */
  listenedMs: number;
  /** Cumulative audible playback of this Track, crossfade overlap undivided; never below `listenedMs`. */
  playedMs: number;
  clientTimestamp: Date;
  endReason: string | null;
  now?: Date;
}

export type RecordListeningResult =
  { ok: true; qualified: boolean } | { ok: false; reason: 'not_found' | 'invalid' | 'cleared' };

/**
 * Fold one progress report into its occurrence. Idempotent and monotonic: only
 * growth in `listenedMs` is credited, so a retry, a duplicate ending, or a late
 * out-of-order report changes nothing. A Track the caller does not own, a
 * Track that does not exist and removed music are the same answer: a tombstone
 * is never linked from analytics, so nothing new is recorded against it. Listening begun before the
 * owner cleared their history is refused, so no late report restores it.
 */
export async function recordListening(
  db: Database,
  input: RecordListeningInput,
): Promise<RecordListeningResult> {
  const now = input.now ?? new Date();
  const reportedAt = input.clientTimestamp.getTime();
  const startedAt = input.startedAt.getTime();
  const plausible =
    Number.isInteger(input.listenedMs) &&
    Number.isInteger(input.playedMs) &&
    input.listenedMs >= 0 &&
    input.listenedMs <= input.playedMs &&
    reportedAt <= now.getTime() + CLOCK_SKEW_MS &&
    startedAt <= reportedAt &&
    startedAt >= now.getTime() - MAX_OCCURRENCE_AGE_MS &&
    input.playedMs <= reportedAt - startedAt + ELAPSED_SLACK_MS;
  if (!plausible) return { ok: false, reason: 'invalid' };

  return withTransaction(db, async (tx) => {
    const [track] = await tx
      .select({
        analyticsId: tracks.analyticsId,
        status: tracks.status,
        durationSeconds: tracks.durationSeconds,
        genreTags: tracks.genreTags,
        energy: tracks.energy,
        vocalMode: tracks.vocalMode,
        bpmEstimate: tracks.bpmEstimate,
        language: trackLanguage(),
      })
      .from(tracks)
      .where(and(eq(tracks.id, input.trackId), eq(tracks.ownerUserId, input.ownerUserId)));
    if (!track || track.status === 'deleted' || track.status === 'rejected')
      return { ok: false, reason: 'not_found' } as const;

    await ensurePreferences(tx, input.ownerUserId);
    // Held to the end of the transaction, so a clearing either sees this
    // occurrence and removes it, or is seen here and refuses it.
    const [preferences] = await tx
      .select({
        historyClearedAt: listeningPreferences.historyClearedAt,
        personalizeSuggestions: listeningPreferences.personalizeSuggestions,
      })
      .from(listeningPreferences)
      .where(eq(listeningPreferences.ownerUserId, input.ownerUserId))
      .for('share');
    const clearedAt = preferences?.historyClearedAt?.getTime();
    // The client's clock may run ahead, so the start is also placed on ours by
    // the elapsed time it reports, which no clock offset changes.
    const startedByOurClock = now.getTime() - (reportedAt - startedAt);
    if (clearedAt !== undefined && Math.min(startedAt, startedByOurClock) <= clearedAt) {
      return { ok: false, reason: 'cleared' } as const;
    }

    // Only Session playback links a Session: a Playlist or preview listen has
    // no Queue behind it, whatever the client sent.
    const ownedSessionId =
      input.surface === 'session' && input.sessionId
        ? ((
            await tx
              .select({ id: activitySessions.id })
              .from(activitySessions)
              .where(
                and(
                  eq(activitySessions.id, input.sessionId),
                  eq(activitySessions.ownerUserId, input.ownerUserId),
                ),
              )
          )[0]?.id ?? null)
        : null;

    await tx
      .insert(listeningOccurrences)
      .values({
        ownerUserId: input.ownerUserId,
        occurrenceId: input.occurrenceId,
        analyticsTrackId: track.analyticsId,
        trackId: input.trackId,
        sessionId: ownedSessionId,
        surface: input.surface,
        startedAt: input.startedAt,
        lastListenedAt: input.startedAt,
        startOrigin: input.origin,
        genreTags: track.genreTags,
        energy: track.energy,
        vocalMode: track.vocalMode,
        bpmEstimate: track.bpmEstimate,
        language: track.language,
        tasteEligible: preferences?.personalizeSuggestions ?? true,
      })
      .onConflictDoNothing();

    const [row] = await tx
      .select()
      .from(listeningOccurrences)
      .where(
        and(
          eq(listeningOccurrences.ownerUserId, input.ownerUserId),
          eq(listeningOccurrences.occurrenceId, input.occurrenceId),
        ),
      )
      .for('update');
    // An occurrence belongs to one Track; an id reused for another is not this occurrence.
    if (!row || row.analyticsTrackId !== track.analyticsId) {
      return { ok: false, reason: 'invalid' } as const;
    }

    const deltaMs = Math.max(0, input.listenedMs - row.listenedMs);
    const listenedMs = row.listenedMs + deltaMs;
    const playedDeltaMs = Math.max(0, input.playedMs - row.playedMs);
    const playedMs = row.playedMs + playedDeltaMs;
    // A play is decided by what the Track itself played: sharing a crossfade
    // with its neighbour halves the credit, not the listening. It lands where
    // the threshold was crossed inside this report's stretch, not at the
    // report's arrival — reports are seconds apart and a midnight can fall
    // between them.
    const thresholdMs = playThresholdMs(track.durationSeconds);
    const qualifiedAt =
      row.qualifiedAt ??
      (playedMs >= thresholdMs
        ? new Date(reportedAt - Math.min(playedDeltaMs, playedMs - thresholdMs))
        : null);

    await tx
      .update(listeningOccurrences)
      .set({
        listenedMs,
        playedMs,
        timeBuckets: allocate(row.timeBuckets, reportedAt, deltaMs),
        lastListenedAt:
          deltaMs > 0 && reportedAt > row.lastListenedAt.getTime()
            ? input.clientTimestamp
            : row.lastListenedAt,
        qualifiedAt,
        endReason: row.endReason ?? input.endReason,
      })
      .where(eq(listeningOccurrences.id, row.id));

    return { ok: true, qualified: qualifiedAt !== null } as const;
  });
}

/**
 * The owner's preferences row. One that has to be created here belongs to an
 * account made after collection began, so its coverage starts with the account.
 * `user.created_at` has no time zone and holds UTC wall-clock time, so it is
 * read as UTC rather than in the database session's time zone.
 */
export async function ensurePreferences(db: DbOrTx, ownerUserId: string) {
  await db.execute(sql`
    insert into ${listeningPreferences} (owner_user_id, collection_started_at)
    select ${user.id}, ${user.createdAt} at time zone 'UTC' from ${user} where ${user.id} = ${ownerUserId}
    on conflict do nothing
  `);
}

/** A most-played entry. A Track that no longer exists keeps its plays and loses everything else. */
export interface TopTrack {
  trackId: string | null;
  title: string | null;
  coverImageId: string | null;
  /** The Session the Track plays through; null once that Session is gone. */
  originSessionId: string | null;
  plays: number;
}

/** Credited time that fell to one genre; `genre` null is time on Tracks with no genre tags. */
export interface TopGenre {
  genre: string | null;
  listenedMs: number;
}

/** Credited time on one calendar day of the reporting timezone. */
export interface DailyListening {
  /** `YYYY-MM-DD`, local to the reporting timezone. */
  day: string;
  listenedMs: number;
}

export interface ListeningStats {
  range: ListeningRange;
  /** The Instance timezone; every date boundary here is local midnight in it. */
  timezone: string;
  /** Start of the range; null for all time. */
  from: Date | null;
  listenedMs: number;
  qualifyingPlays: number;
  /** Distinct Tracks with credited time in the range, deleted ones included. */
  uniqueTracks: number;
  /** By qualifying plays, at most `TOP_TRACKS_LIMIT`. */
  topTracks: TopTrack[];
  /** By credited time, a play or not, at most `TOP_GENRES_LIMIT`. */
  topGenres: TopGenre[];
  /**
   * Days with credited time, oldest first; a day without listening has no
   * entry. At most the `DAILY_LISTENING_LIMIT` days ending today, so all time
   * stays a bounded list.
   */
  daily: DailyListening[];
  collectionStartedAt: Date;
  /** The range reaches back past collection: its early part is unknown, not silent. */
  rangePredatesCollection: boolean;
}

export const TOP_TRACKS_LIMIT = 10;
export const TOP_GENRES_LIMIT = 8;

/** Local midnight opening the range's calendar days, the last of which is today; null for all time. */
export function reportingRangeStart(
  now: Date,
  timezone: string,
  range: ListeningRange,
): Date | null {
  if (range === 'all') return null;
  return localMidnightDaysBack(now, timezone, LISTENING_RANGE_DAYS[range]);
}

/** Local midnight opening the `days` calendar days that end with today. */
function localMidnightDaysBack(now: Date, timezone: string, days: number): Date {
  const today = limitWindowStarts(now, timezone).dayStart;
  // Aim at the middle of the target day so a DST shift cannot land on its neighbour.
  const insideFirstDay = new Date(today.getTime() - (days - 1) * DAY_MS + DAY_MS / 2);
  return limitWindowStarts(insideFirstDay, timezone).dayStart;
}

export interface ListeningStatsQuery {
  ownerUserId: string;
  range: ListeningRange;
  now: Date;
  timezone: string;
}

/** The calendar a read answers on: the Instance timezone's days, and how far back records reach. */
export async function resolveReporting(db: Database, input: ListeningStatsQuery) {
  await ensurePreferences(db, input.ownerUserId);
  const [preferences] = await db
    .select({ collectionStartedAt: listeningPreferences.collectionStartedAt })
    .from(listeningPreferences)
    .where(eq(listeningPreferences.ownerUserId, input.ownerUserId));
  if (!preferences) throw new Error('Listening stats requested for an unknown user.');
  const from = reportingRangeStart(input.now, input.timezone, input.range);
  return {
    timezone: input.timezone,
    from,
    collectionStartedAt: preferences.collectionStartedAt,
  };
}

type Reporting = Awaited<ReturnType<typeof resolveReporting>>;

/**
 * Every aggregate runs in Postgres over the owner's index range and returns a
 * bounded list, so a lifetime of listening never enters the web process.
 */
async function measureListeningStats(
  db: Database,
  input: ListeningStatsQuery,
  { timezone, from, collectionStartedAt }: Reporting,
): Promise<ListeningStats> {
  const o = listeningOccurrences;
  const fromBucket = from ? Math.floor(from.getTime() / BUCKET_MS) : null;
  // `qualified_at` and every bucket precede `last_listened_at`, so the indexed
  // column bounds both reads.
  const inReach = from
    ? sql`${o.ownerUserId} = ${input.ownerUserId} and ${o.lastListenedAt} >= ${from.toISOString()}::timestamptz`
    : sql`${o.ownerUserId} = ${input.ownerUserId}`;
  // Credited time per occurrence that fell inside the range.
  const credited = sql`
    select ${o.id} as id, ${o.analyticsTrackId} as analytics_track_id,
      ${o.genreTags} as genre_tags, sum(slice.value::bigint) as ms
    from ${o}
    cross join lateral jsonb_each_text(${o.timeBuckets}) as slice
    where ${inReach}
      and (${fromBucket}::bigint is null or slice.key::bigint >= ${fromBucket}::bigint)
    group by ${o.id}
  `;

  const totals = await db.execute<{ listened_ms: string; unique_tracks: string }>(sql`
    with credited as (${credited})
    select coalesce(sum(ms), 0) as listened_ms,
      count(distinct analytics_track_id) filter (where ms > 0) as unique_tracks
    from credited
  `);

  // A Track's time is shared equally by its distinct normalized tags. No tag at
  // all leaves the time with the null genre instead of dropping it.
  const genres = await db.execute<{ genre: string | null; listened_ms: string }>(sql`
    with credited as (${credited})
    select tag as genre, round(sum(credited.ms::numeric / greatest(cardinality(n.tags), 1))) as listened_ms
    from credited
    cross join lateral (
      select ${normalizedGenreTags(sql`credited.genre_tags`)} as tags
    ) as n
    left join lateral unnest(n.tags) as tag on true
    where credited.ms > 0
    group by tag
    order by listened_ms desc, tag
    limit ${TOP_GENRES_LIMIT}
  `);

  // A 15-minute bucket never straddles a local midnight: every timezone's
  // offset is a multiple of 15 minutes.
  const dailyFrom = localMidnightDaysBack(input.now, timezone, DAILY_LISTENING_LIMIT);
  const dailyFromBucket = Math.floor(
    Math.max(dailyFrom.getTime(), from?.getTime() ?? 0) / BUCKET_MS,
  );
  const daily = await db.execute<{ day: string; listened_ms: string }>(sql`
    select to_char(
        to_timestamp(slice.key::bigint * ${BUCKET_MS / 1000}) at time zone ${timezone},
        'YYYY-MM-DD'
      ) as day,
      sum(slice.value::bigint) as listened_ms
    from ${o}
    cross join lateral jsonb_each_text(${o.timeBuckets}) as slice
    where ${o.ownerUserId} = ${input.ownerUserId}
      and ${o.lastListenedAt} >= ${dailyFrom.toISOString()}::timestamptz
      and slice.key::bigint >= ${dailyFromBucket}::bigint
    group by day
    having sum(slice.value::bigint) > 0
    order by day
  `);

  const qualified = from
    ? sql`${inReach} and ${o.qualifiedAt} >= ${from.toISOString()}::timestamptz`
    : sql`${inReach} and ${o.qualifiedAt} is not null`;
  // Ranked by the opaque identity so a deleted Track keeps its place; only a
  // Track the owner can still open lends the entry an id and a title.
  const played = await db.execute<{
    track_id: string | null;
    title: string | null;
    cover_image_id: string | null;
    origin_session_id: string | null;
    plays: string;
    total_plays: string;
  }>(sql`
    with ranked as (
      select ${o.analyticsTrackId} as analytics_track_id,
        (array_agg(${o.trackId}) filter (where ${o.trackId} is not null))[1] as track_id,
        count(*) as plays,
        max(${o.qualifiedAt}) as last_qualified_at,
        sum(count(*)) over () as total_plays
      from ${o}
      where ${qualified}
      group by ${o.analyticsTrackId}
      order by plays desc, last_qualified_at desc
      limit ${TOP_TRACKS_LIMIT}
    )
    select ${tracks.id} as track_id, ${tracks.title} as title,
      ${effectiveTrackCoverColumn(activitySessions.coverImageId, tracks.coverImageId)} as cover_image_id,
      case when ${sessionNotPendingDelete()} then ${activitySessions.id} end as origin_session_id,
      ranked.plays, ranked.total_plays
    from ranked
    left join ${tracks} on ${tracks.id} = ranked.track_id
      and ${tracks.ownerUserId} = ${input.ownerUserId}
      and ${tracks.dislikedAt} is null
    left join ${generationRequests} on ${generationRequests.id} = ${tracks.generationRequestId}
    left join ${activitySessions}
      on ${activitySessions.id} = ${generationRequests.activitySessionId}
    order by ranked.plays desc, ranked.last_qualified_at desc
  `);

  return {
    range: input.range,
    timezone,
    from,
    listenedMs: Number(totals.rows[0]?.listened_ms ?? 0),
    qualifyingPlays: Number(played.rows[0]?.total_plays ?? 0),
    uniqueTracks: Number(totals.rows[0]?.unique_tracks ?? 0),
    topTracks: played.rows.map((row) => ({
      trackId: row.track_id,
      title: row.track_id ? row.title : null,
      coverImageId: row.track_id ? row.cover_image_id : null,
      originSessionId: row.track_id ? row.origin_session_id : null,
      plays: Number(row.plays),
    })),
    topGenres: genres.rows.map((row) => ({
      genre: row.genre,
      listenedMs: Number(row.listened_ms),
    })),
    daily: daily.rows.map((row) => ({ day: row.day, listenedMs: Number(row.listened_ms) })),
    collectionStartedAt,
    rangePredatesCollection: from !== null && from < collectionStartedAt,
  };
}

export async function getListeningStats(
  db: Database,
  input: ListeningStatsQuery,
): Promise<ListeningStats> {
  return measureListeningStats(db, input, await resolveReporting(db, input));
}

/**
 * How long an answer is served while the owner's listening stands still. The
 * listening it sums cannot change under it (see `CachedListeningStats.query`);
 * only what a Track is called or whether it still exists can, and that may lag
 * this long.
 */
const LISTENING_STATS_CACHE_TTL_MS = 5 * 60_000;

/** Names the fields of `CachedListeningStats.stats`, so an answer stored in another shape measures again. */
const CACHED_STATS_SHAPE = 'v2';

/** The latest measured answer, cached per owner in `user_settings`. */
interface CachedListeningStats {
  /**
   * The question and the listening it was asked of: range, calendar, and the
   * owner's occurrence count, how many still link a Track, and the newest
   * credited instant. A report or a clearing moves the first or last, and
   * removing music moves the middle one, so a cached answer neither predates
   * the records it sums nor names a Track removed since.
   */
  query: string;
  /** ISO-8601; the age that decides whether the aggregates run again. */
  measuredAt: string;
  stats: Omit<ListeningStats, 'from' | 'collectionStartedAt'> & {
    from: string | null;
    collectionStartedAt: string;
  };
}

/**
 * `getListeningStats` behind a per-owner cache — the seam user-facing reads use.
 * The row is keyed by owner, and its `query` by everything else the answer
 * depends on. Concurrent misses both measure and write the same answer.
 */
export async function getCachedListeningStats(
  db: Database,
  input: ListeningStatsQuery,
): Promise<ListeningStats> {
  const reporting = await resolveReporting(db, input);
  const [state] = await db
    .select({
      occurrences: sql<string>`count(*)`,
      linked: sql<string>`count(${listeningOccurrences.trackId})`,
      newest: sql<string | null>`max(${listeningOccurrences.lastListenedAt})::text`,
    })
    .from(listeningOccurrences)
    .where(eq(listeningOccurrences.ownerUserId, input.ownerUserId));
  const query = [
    CACHED_STATS_SHAPE,
    input.range,
    reporting.timezone,
    reporting.from?.toISOString() ?? '*',
    state?.occurrences ?? 0,
    state?.linked ?? 0,
    state?.newest ?? '-',
  ].join('|');

  const cached = await readUserSetting<CachedListeningStats>(
    db,
    input.ownerUserId,
    USER_SETTINGS_KEYS.listeningStats,
  );
  // An unparseable timestamp is NaN, which no comparison accepts, so a damaged
  // record measures again.
  const age = cached ? input.now.getTime() - Date.parse(cached.measuredAt) : NaN;
  if (cached?.query === query && age >= 0 && age < LISTENING_STATS_CACHE_TTL_MS) {
    return {
      ...cached.stats,
      from: cached.stats.from === null ? null : new Date(cached.stats.from),
      collectionStartedAt: new Date(cached.stats.collectionStartedAt),
    };
  }

  const stats = await measureListeningStats(db, input, reporting);
  const measured: CachedListeningStats = {
    query,
    measuredAt: input.now.toISOString(),
    stats: {
      ...stats,
      from: stats.from?.toISOString() ?? null,
      collectionStartedAt: stats.collectionStartedAt.toISOString(),
    },
  };
  await writeUserSetting(db, input.ownerUserId, USER_SETTINGS_KEYS.listeningStats, measured);
  return stats;
}
