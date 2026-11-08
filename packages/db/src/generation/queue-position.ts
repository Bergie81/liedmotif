import { eq, sql } from 'drizzle-orm';
import { SESSION_QUEUE_POSITION_LOCK_CLASS } from '../advisory-locks';
import type { Transaction } from '../transactions';
import { activitySessionQueueItems } from '../schema';

/**
 * The next free Queue position of a Session. Positions have no unique index, so
 * two transactions appending at once (two jobs materializing together) would
 * both read the same `max` — the per-session lock serializes the read with the
 * caller's insert, held until its transaction ends.
 */
export async function nextSessionQueuePosition(
  tx: Transaction,
  sessionId: string,
): Promise<number> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${SESSION_QUEUE_POSITION_LOCK_CLASS}, hashtext(${sessionId}))`,
  );
  const [row] = await tx
    .select({ next: sql<number>`coalesce(max(${activitySessionQueueItems.position}), -1) + 1` })
    .from(activitySessionQueueItems)
    .where(eq(activitySessionQueueItems.activitySessionId, sessionId));
  return Number(row?.next ?? 0);
}
