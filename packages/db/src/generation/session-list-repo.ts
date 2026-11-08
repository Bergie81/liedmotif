import { and, desc, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { EMPTY_SESSION_TRACK_ACTIVITY, MAX_PINNED_SESSIONS } from '@liedmotif/shared';
import type { Database } from '../client';
import { activitySessions } from '../schema';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor';
import { getSessionTrackActivities } from './session-activity-repo';

export interface ResumableSessionItem {
  id: string;
  title: string | null;
  coverImageId: string | null;
  lastActiveAt: Date;
  status: 'stopped';
  trackCount: number;
  totalDurationSeconds: number;
  genreTags: string[];
  pinned: boolean;
}

export interface ListResumableSessionsResult {
  items: ResumableSessionItem[];
  nextCursor: string | null;
}

/** The most-recent-active instant — the My Sessions sort key, shared with search. */
export const sessionLastActiveExpr = sql<string>`coalesce(${activitySessions.lastPlaybackReportAt}, ${activitySessions.stoppedAt}, ${activitySessions.lastResumedAt}, ${activitySessions.startedAt})`;

/** A session whose delete is pending (`deleteRequestedAt`) is gone to its owner. */
export function sessionNotPendingDelete(): SQL {
  return isNull(activitySessions.deleteRequestedAt);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** List the owner's resumable Stopped Sessions with their bounded card activity. */
export async function listResumableSessions(
  db: Database,
  args: {
    ownerUserId: string;
    cursor?: string | null;
    limit: number;
    /** Leave pinned Sessions out — they render in their own Pinned section. */
    excludePinned?: boolean;
  },
): Promise<ListResumableSessionsResult> {
  const cursor = args.cursor ? decodeKeysetCursor(args.cursor) : null;
  const conditions = [
    eq(activitySessions.ownerUserId, args.ownerUserId),
    eq(activitySessions.status, 'stopped'),
    sessionNotPendingDelete(),
  ];
  if (args.excludePinned) conditions.push(isNull(activitySessions.pinnedAt));
  if (cursor) {
    conditions.push(
      sql`(coalesce(${activitySessions.lastPlaybackReportAt}, ${activitySessions.stoppedAt}, ${activitySessions.lastResumedAt}, ${activitySessions.startedAt}), ${activitySessions.id}) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)`,
    );
  }

  const rows = await selectSessionRows(db, and(...conditions))
    .orderBy(desc(sessionLastActiveExpr), desc(activitySessions.id))
    .limit(args.limit + 1);

  const hasMore = rows.length > args.limit;
  const page = hasMore ? rows.slice(0, args.limit) : rows;
  const items = await withTrackActivity(db, args.ownerUserId, page);
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeKeysetCursor({ t: toDate(last.lastActiveAt).toISOString(), id: last.id })
      : null;
  return { items, nextCursor };
}

/** The owner's pinned Stopped Sessions for the Pinned section, newest pin first. */
export async function listPinnedSessions(
  db: Database,
  args: { ownerUserId: string },
): Promise<ResumableSessionItem[]> {
  const rows = await selectSessionRows(
    db,
    and(
      eq(activitySessions.ownerUserId, args.ownerUserId),
      eq(activitySessions.status, 'stopped'),
      isNotNull(activitySessions.pinnedAt),
      sessionNotPendingDelete(),
    ),
  )
    .orderBy(desc(activitySessions.pinnedAt), desc(activitySessions.id))
    .limit(MAX_PINNED_SESSIONS);
  return withTrackActivity(db, args.ownerUserId, rows);
}

interface SessionRow {
  id: string;
  title: string | null;
  coverImageId: string | null;
  lastActiveAt: Date | string;
  pinnedAt: Date | null;
}

function selectSessionRows(db: Database, where: SQL | undefined) {
  return db
    .select({
      id: activitySessions.id,
      title: activitySessions.title,
      coverImageId: activitySessions.coverImageId,
      lastActiveAt: sessionLastActiveExpr,
      pinnedAt: activitySessions.pinnedAt,
    })
    .from(activitySessions)
    .where(where)
    .$dynamic();
}

async function withTrackActivity(
  db: Database,
  ownerUserId: string,
  rows: SessionRow[],
): Promise<ResumableSessionItem[]> {
  const activityBySession = await getSessionTrackActivities(db, {
    ownerUserId,
    sessionIds: rows.map((row) => row.id),
  });
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    coverImageId: row.coverImageId,
    lastActiveAt: toDate(row.lastActiveAt),
    status: 'stopped',
    ...(activityBySession.get(row.id) ?? EMPTY_SESSION_TRACK_ACTIVITY),
    pinned: row.pinnedAt !== null,
  }));
}
