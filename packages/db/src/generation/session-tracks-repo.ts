import { and, asc, eq, sql } from 'drizzle-orm';
import type { SessionTracksData } from '@liedmotif/shared';
import type { Database } from '../client';
import type { Transaction } from '../transactions';
import { activitySessions, activitySessionQueueItems, generationRequests, tracks } from '../schema';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor';
import { nextSessionQueuePosition } from './queue-position';
import { getSessionTrackActivity } from './session-activity-repo';
import { playableSessionTrackCondition, sessionTrackQueueEdge } from './session-track-playability';

// Cursor timestamps use JavaScript precision; the ordering must use the same precision.
const createdAt = sql<string>`date_trunc('milliseconds', ${tracks.createdAt})`;

function playableTrackInSession(args: { ownerUserId: string; sessionId: string }) {
  return and(
    eq(generationRequests.activitySessionId, args.sessionId),
    eq(generationRequests.ownerUserId, args.ownerUserId),
    playableSessionTrackCondition(args.ownerUserId),
  );
}

export async function listSessionTracks(
  db: Database,
  args: { ownerUserId: string; sessionId: string; cursor: string | null; limit: number },
): Promise<SessionTracksData | null> {
  const [session] = await db
    .select({ id: activitySessions.id })
    .from(activitySessions)
    .where(
      and(
        eq(activitySessions.id, args.sessionId),
        eq(activitySessions.ownerUserId, args.ownerUserId),
      ),
    );
  if (!session) return null;

  const cursor = args.cursor ? decodeKeysetCursor(args.cursor) : null;
  const [activity, rows] = await Promise.all([
    getSessionTrackActivity(db, args),
    db
      .select({
        id: tracks.id,
        title: tracks.title,
        durationSeconds: tracks.durationSeconds,
        styleRevision: generationRequests.styleRevision,
        createdAt,
      })
      .from(generationRequests)
      .innerJoin(tracks, eq(tracks.generationRequestId, generationRequests.id))
      .leftJoin(activitySessionQueueItems, sessionTrackQueueEdge)
      .where(
        and(
          playableTrackInSession(args),
          cursor
            ? sql`(${createdAt}, ${tracks.id}) > (${cursor.t}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(createdAt), asc(tracks.id))
      .limit(args.limit + 1),
  ]);
  const page = rows.slice(0, args.limit);
  const last = page.at(-1);
  return {
    items: page.map(({ id, title, durationSeconds, styleRevision }) => ({
      id,
      title,
      durationSeconds,
      styleRevision,
    })),
    total: activity.trackCount,
    totalDurationSeconds: activity.totalDurationSeconds,
    genreTags: activity.genreTags,
    nextCursor:
      rows.length > args.limit && last
        ? encodeKeysetCursor({ t: new Date(last.createdAt).toISOString(), id: last.id })
        : null,
  };
}

/** The Session's listed Tracks in list order: the whole of what `listSessionTracks` pages. */
export async function listPlayableSessionTrackIds(
  db: Database | Transaction,
  args: { ownerUserId: string; sessionId: string },
): Promise<string[]> {
  const rows = await db
    .select({ id: tracks.id })
    .from(generationRequests)
    .innerJoin(tracks, eq(tracks.generationRequestId, generationRequests.id))
    .leftJoin(activitySessionQueueItems, sessionTrackQueueEdge)
    .where(playableTrackInSession(args))
    .orderBy(asc(createdAt), asc(tracks.id));
  return rows.map((row) => row.id);
}

/** Called under the owner's generation lock; browsing never creates Queue slots. */
export async function resolvePlayableSessionTrackSlot(
  tx: Transaction,
  args: { ownerUserId: string; sessionId: string; trackId: string },
): Promise<string | null> {
  const [track] = await tx
    .select({ queueItemId: activitySessionQueueItems.id, requestId: generationRequests.id })
    .from(generationRequests)
    .innerJoin(tracks, eq(tracks.generationRequestId, generationRequests.id))
    .leftJoin(activitySessionQueueItems, sessionTrackQueueEdge)
    .where(and(playableTrackInSession(args), eq(tracks.id, args.trackId)))
    .for('update', { of: tracks });
  if (!track) return null;
  if (track.queueItemId) return track.queueItemId;

  const position = await nextSessionQueuePosition(tx, args.sessionId);
  await tx
    .insert(activitySessionQueueItems)
    .values({
      activitySessionId: args.sessionId,
      trackId: args.trackId,
      generationRequestId: track.requestId,
      position,
      state: 'queued',
    })
    .onConflictDoNothing({
      target: [activitySessionQueueItems.activitySessionId, activitySessionQueueItems.trackId],
      where: sql`${activitySessionQueueItems.trackId} is not null`,
    });
  const [slot] = await tx
    .select({ id: activitySessionQueueItems.id })
    .from(activitySessionQueueItems)
    .where(
      and(
        eq(activitySessionQueueItems.activitySessionId, args.sessionId),
        eq(activitySessionQueueItems.trackId, args.trackId),
      ),
    );
  return slot?.id ?? null;
}
