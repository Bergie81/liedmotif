// Session deletion (My Sessions "Delete") — the one flow that destroys a
// session identity. Everything money- and library-shaped survives it:
// generation requests / provider jobs keep their rows with the session edge
// severed (spend counting reads `provider_jobs`, never the session), cover
// ledger rows survive as cover-spend accounting, Saved/Favorited tracks stay
// in the Library wearing the session's cover, and feedback events keep their
// history. What is reclaimed in the same commit: the session's Ephemeral
// tracks' audio, and every cover in its history that nothing else references.

import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { phantomSubmitCutoffAt } from '@liedmotif/shared';
import type { Database } from '../client';
import { withTransaction, type Transaction } from '../transactions';
import { activitySessions, SESSION_COVER_LIVE_STATES, sessionCoverGenerations } from '../schema';
import { acquireOwnerCoverArtLock } from '../covers/generated-repo';
import {
  acquireOwnerCoverAdmissionLock,
  sessionLedgerSubject,
} from '../covers/generation-ledger-repo';
import {
  deleteUnreferencedCoverRows,
  listSubjectCoverImageIds,
  queueCoverFileDeletions,
  snapshotSessionCoverOntoTracks,
} from '../covers/cover-reclaim';
import { evictSessionEphemeralAudio } from './eviction-repo';
import { lockSessionForCoverPlanning } from './session-command-repo';
import { countInFlightSessionJobs } from './sessions-repo';

export type DeleteSessionResult =
  | { ok: true; id: string; deferred: false; evictedTrackCount: number }
  | { ok: true; id: string; deferred: true }
  | { ok: false; reason: 'not_found' | 'active' };

/**
 * Permanently delete a STOPPED session: the row and its queue items (FK
 * cascade). Its playback events stay with their session edge set null, so a
 * kept Track still reads as played. Refused while `active` (Stop is the
 * lifecycle move).
 * While provider jobs or a cover generation are in flight the delete is
 * deferred instead — a track or cover landing AFTER the delete would sever its
 * session edge with no remaining flow to reclaim its bytes — so the session is
 * marked `deleteRequestedAt` and unpinned, which takes it out of My Sessions,
 * search, Resume and track playback, and `finishDeferredSessionDeletes`
 * completes it once the work settles.
 */
export async function deleteSession(
  db: Database,
  args: { ownerUserId: string; sessionId: string; now?: Date },
): Promise<DeleteSessionResult> {
  const now = args.now ?? new Date();
  return withTransaction(db, async (tx) => {
    // Admission is always acquired before the privacy lock. Deletion needs both
    // so no planner can reserve work after the final live-work check.
    await acquireOwnerCoverAdmissionLock(tx, args.ownerUserId);
    await acquireOwnerCoverArtLock(tx, args.ownerUserId);
    const target = await lockSessionForCoverPlanning(tx, args);
    if (!target) return { ok: false as const, reason: 'not_found' as const };
    if (target.status !== 'stopped') return { ok: false as const, reason: 'active' as const };

    if (await hasLiveGenerationWork(tx, { ...args, now })) {
      if (!target.deleteRequestedAt) {
        await tx
          .update(activitySessions)
          .set({ deleteRequestedAt: now, pinnedAt: null })
          .where(eq(activitySessions.id, args.sessionId));
      }
      return { ok: true as const, id: args.sessionId, deferred: true as const };
    }

    // Cover candidates key on the subject edge — gathered before it is severed.
    const coverCandidateIds = await listSubjectCoverImageIds(
      tx,
      args.ownerUserId,
      sessionLedgerSubject(args.sessionId),
    );

    const { evictedTrackIds } = await evictSessionEphemeralAudio(tx, {
      sessionId: args.sessionId,
      ownerUserId: args.ownerUserId,
      now,
    });

    await snapshotSessionCoverOntoTracks(tx, {
      ownerUserId: args.ownerUserId,
      sessionId: args.sessionId,
      coverImageId: target.coverImageId,
    });

    // Ledger rows survive as cover-spend accounting; the edge is severed by
    // hand because the composite FK carries no ON DELETE action.
    await tx
      .update(sessionCoverGenerations)
      .set({ activitySessionId: null })
      .where(
        and(
          eq(sessionCoverGenerations.ownerUserId, args.ownerUserId),
          eq(sessionCoverGenerations.activitySessionId, args.sessionId),
        ),
      );

    // Guarded on `stopped` so a Resume that re-activated the session between the
    // read above and here wins (0 rows deleted → report it as active, not gone).
    const deleted = await tx
      .delete(activitySessions)
      .where(
        and(
          eq(activitySessions.id, args.sessionId),
          eq(activitySessions.ownerUserId, args.ownerUserId),
          eq(activitySessions.status, 'stopped'),
        ),
      )
      .returning({ id: activitySessions.id });
    if (deleted.length === 0) return { ok: false as const, reason: 'active' as const };

    // With the session row gone, the shared unreferenced-cover predicate alone
    // decides what survives — e.g. the snapshot above keeps the current cover.
    const reclaimed = await deleteUnreferencedCoverRows(tx, {
      coverImageIds: coverCandidateIds,
    });
    await queueCoverFileDeletions(tx, {
      ownerUserId: args.ownerUserId,
      covers: reclaimed,
      reason: 'session_deleted',
      now,
    });

    return {
      ok: true as const,
      id: args.sessionId,
      deferred: false as const,
      evictedTrackCount: evictedTrackIds.length,
    };
  });
}

/** Provider jobs or a cover generation whose late result would outlive the delete. */
async function hasLiveGenerationWork(
  tx: Transaction,
  args: { ownerUserId: string; sessionId: string; now: Date },
): Promise<boolean> {
  const inFlight = await countInFlightSessionJobs(tx, {
    sessionId: args.sessionId,
    phantomSubmitCutoff: phantomSubmitCutoffAt(args.now),
  });
  if (inFlight > 0) return true;
  const [liveCover] = await tx
    .select({ id: sessionCoverGenerations.id })
    .from(sessionCoverGenerations)
    .where(
      and(
        eq(sessionCoverGenerations.ownerUserId, args.ownerUserId),
        eq(sessionCoverGenerations.activitySessionId, args.sessionId),
        inArray(sessionCoverGenerations.state, [...SESSION_COVER_LIVE_STATES]),
      ),
    )
    .limit(1);
  return liveCover !== undefined;
}

/**
 * The worker half of a deferred delete: retry every pending one. A session
 * still waiting on in-flight work stays pending for the next run; a settled one
 * is deleted through the same path as an immediate delete. One session that
 * fails never holds back the rest.
 */
export async function finishDeferredSessionDeletes(
  db: Database,
): Promise<{ deletedSessionIds: string[]; failedSessionIds: string[] }> {
  const pending = await db
    .select({ id: activitySessions.id, ownerUserId: activitySessions.ownerUserId })
    .from(activitySessions)
    .where(isNotNull(activitySessions.deleteRequestedAt));
  const deletedSessionIds: string[] = [];
  const failedSessionIds: string[] = [];
  for (const session of pending) {
    try {
      const result = await deleteSession(db, {
        ownerUserId: session.ownerUserId,
        sessionId: session.id,
      });
      if (result.ok && !result.deferred) deletedSessionIds.push(session.id);
    } catch {
      failedSessionIds.push(session.id);
    }
  }
  return { deletedSessionIds, failedSessionIds };
}
