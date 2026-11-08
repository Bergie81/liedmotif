import { and, count, eq, isNotNull, sql } from 'drizzle-orm';
import { MAX_PINNED_SESSIONS } from '@liedmotif/shared';
import { OWNER_SESSION_PIN_LOCK_CLASS } from '../advisory-locks';
import type { Database } from '../client';
import { activitySessions } from '../schema';
import { withTransaction } from '../transactions';
import { sessionNotPendingDelete } from './session-list-repo';

export type SetSessionPinnedResult = 'ok' | 'not_found' | 'limit_reached';

/**
 * Pin or unpin an owned Session. Pinning counts against the per-owner cap under
 * a per-owner lock, so concurrent pins can never overshoot it; re-pinning an
 * already pinned Session keeps its original pin instant (and its place in the order).
 */
export async function setSessionPinned(
  db: Database,
  args: { ownerUserId: string; sessionId: string; pinned: boolean },
): Promise<SetSessionPinnedResult> {
  const owned = and(
    eq(activitySessions.id, args.sessionId),
    eq(activitySessions.ownerUserId, args.ownerUserId),
    sessionNotPendingDelete(),
  );
  if (!args.pinned) {
    const rows = await db
      .update(activitySessions)
      .set({ pinnedAt: null })
      .where(owned)
      .returning({ id: activitySessions.id });
    return rows.length > 0 ? 'ok' : 'not_found';
  }

  return withTransaction(db, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNER_SESSION_PIN_LOCK_CLASS}, hashtext(${args.ownerUserId}))`,
    );
    const [session] = await tx
      .select({ pinnedAt: activitySessions.pinnedAt })
      .from(activitySessions)
      .where(owned);
    if (!session) return 'not_found';
    if (session.pinnedAt) return 'ok';

    const [pinnedCount] = await tx
      .select({ value: count() })
      .from(activitySessions)
      .where(
        and(
          eq(activitySessions.ownerUserId, args.ownerUserId),
          isNotNull(activitySessions.pinnedAt),
        ),
      );
    if ((pinnedCount?.value ?? 0) >= MAX_PINNED_SESSIONS) return 'limit_reached';

    await tx
      .update(activitySessions)
      .set({ pinnedAt: sql`now()` })
      .where(owned);
    return 'ok';
  });
}
