// The repeat-one loop-lease state machine.
// One row per (session, client): each tab/device owns its OWN lease, so the
// Repeat-one protocol rules hold by construction:
//
// - `epoch` is monotonic PER CLIENT and only ever compared against the SAME
//   client's stored row. A same-client operation with `epoch` below the stored
//   one is STALE and never applied — a delayed renew (or acquire) that arrives
//   after a newer release can never resurrect the hold, because the row
//   SURVIVES a release keeping the released epoch to compare against.
// - `acquire` creates or refreshes the caller's own lease; it never touches
//   another client's row, so no takeover exists to reason about.
// - `renew` extends the caller's own LIVE lease only; it never creates one.
// - `release` releases the caller's own lease only — another tab literally
//   cannot cancel a hold it doesn't own (it has no row to release), and a
//   second tab's hold is independent (its own row).
// - The SESSION is held while ANY unexpired, unreleased lease exists; expiry
//   lapses a hold implicitly and the buffer sweep resumes prefill.
//
// Every operation answers with the acknowledged post-operation truth: whether
// it applied, whether the session is held, and the caller's own lease state.

import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { LOOP_LEASE_TTL_SECONDS, type LoopLeaseAction } from '@liedmotif/shared';
import type { Database } from '../client';
import { withTransaction, type DbOrTx } from '../transactions';
import { activitySessions, sessionLoopLeases } from '../schema';

/** The caller's own lease row, as acknowledged back to it. */
export interface OwnLoopLease {
  epoch: number;
  expiresAt: Date;
  released: boolean;
}

/** The lease's acknowledged state after an operation. */
export interface LoopLeaseState {
  /** Session-level: ANY client currently holds an unexpired, unreleased lease. */
  held: boolean;
  /** The CALLER's own lease row (null when it never held one). */
  lease: OwnLoopLease | null;
}

export type ApplyLoopLeaseResult =
  { ok: true; applied: boolean; state: LoopLeaseState } | { ok: false; reason: 'not_found' };

interface LeaseRow {
  epoch: number;
  expiresAt: Date;
  releasedAt: Date | null;
}

function isLive(lease: LeaseRow | undefined, now: Date): boolean {
  return lease != null && lease.releasedAt === null && lease.expiresAt.getTime() > now.getTime();
}

function toOwnLease(lease: LeaseRow | undefined): OwnLoopLease | null {
  if (!lease) return null;
  return { epoch: lease.epoch, expiresAt: lease.expiresAt, released: lease.releasedAt !== null };
}

/** Whether ANY client holds a live lease on the session (the sweep predicate). */
async function sessionHeld(db: DbOrTx, sessionId: string, now: Date): Promise<boolean> {
  const [live] = await db
    .select({ clientId: sessionLoopLeases.clientId })
    .from(sessionLoopLeases)
    .where(
      and(
        eq(sessionLoopLeases.activitySessionId, sessionId),
        isNull(sessionLoopLeases.releasedAt),
        gt(sessionLoopLeases.expiresAt, now),
      ),
    )
    .limit(1);
  return live !== undefined;
}

/**
 * Apply one lease operation for an OWNED session. The caller's own row is
 * locked (`FOR UPDATE`) when it exists; a first acquire races only same-client
 * duplicates on the composite PK, which the conditional upsert resolves without
 * ever letting a lower epoch overwrite a higher one. Returns `not_found` when
 * the session is absent or not owned (the standard IDOR posture).
 */
export async function applyLoopLease(
  db: Database,
  args: {
    ownerUserId: string;
    sessionId: string;
    clientId: string;
    epoch: number;
    action: LoopLeaseAction;
    ttlSeconds?: number;
    now?: Date;
  },
): Promise<ApplyLoopLeaseResult> {
  const now = args.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (args.ttlSeconds ?? LOOP_LEASE_TTL_SECONDS) * 1000);
  const ownLeaseFilter = and(
    eq(sessionLoopLeases.activitySessionId, args.sessionId),
    eq(sessionLoopLeases.clientId, args.clientId),
  );

  return withTransaction(db, async (tx) => {
    const [session] = await tx
      .select({ id: activitySessions.id })
      .from(activitySessions)
      .where(
        and(
          eq(activitySessions.id, args.sessionId),
          eq(activitySessions.ownerUserId, args.ownerUserId),
        ),
      )
      .limit(1);
    if (!session) return { ok: false as const, reason: 'not_found' as const };

    const readOwnLease = async (lock: boolean): Promise<LeaseRow | undefined> => {
      const query = tx
        .select({
          epoch: sessionLoopLeases.epoch,
          expiresAt: sessionLoopLeases.expiresAt,
          releasedAt: sessionLoopLeases.releasedAt,
        })
        .from(sessionLoopLeases)
        .where(ownLeaseFilter)
        .limit(1);
      const [row] = await (lock ? query.for('update') : query);
      return row;
    };

    const acknowledge = async (applied: boolean, own?: LeaseRow) => ({
      ok: true as const,
      applied,
      state: {
        held: await sessionHeld(tx, args.sessionId, now),
        lease: toOwnLease(own ?? (await readOwnLease(false))),
      },
    });

    switch (args.action) {
      case 'acquire': {
        // Conditional upsert: create the caller's lease, or refresh it only when
        // the incoming epoch is AHEAD of the stored one — a delayed acquire that
        // lost a race (or arrived after a newer release) changes nothing. An
        // EQUAL epoch refreshes only a LIVE lease (unreleased AND unexpired): a
        // release records the same epoch as the acquire it ends, and expiry is
        // the crash/network-loss lapse mechanism — a duplicate in-flight acquire
        // retry with the old epoch must resurrect neither; re-acquiring after a
        // release or a lapse takes a strictly newer epoch. The guard runs INSIDE
        // the upsert, so concurrent same-client acquires can interleave in any
        // order and the newest epoch always wins.
        const applied = await tx
          .insert(sessionLoopLeases)
          .values({
            activitySessionId: args.sessionId,
            clientId: args.clientId,
            epoch: args.epoch,
            expiresAt,
          })
          .onConflictDoUpdate({
            target: [sessionLoopLeases.activitySessionId, sessionLoopLeases.clientId],
            set: { epoch: args.epoch, expiresAt, releasedAt: null },
            setWhere: sql`(${sessionLoopLeases.releasedAt} is null and ${sessionLoopLeases.expiresAt} > ${now} and ${sessionLoopLeases.epoch} <= ${args.epoch}) or ${sessionLoopLeases.epoch} < ${args.epoch}`,
          })
          .returning({ epoch: sessionLoopLeases.epoch });
        return acknowledge(applied.length > 0);
      }
      case 'renew': {
        // Renewal extends the caller's own LIVE lease only — it never creates or
        // resurrects one (a lapsed/released lease needs a deliberate acquire).
        const own = await readOwnLease(true);
        if (!own || own.epoch > args.epoch || !isLive(own, now)) return acknowledge(false, own);
        await tx
          .update(sessionLoopLeases)
          .set({ epoch: args.epoch, expiresAt })
          .where(ownLeaseFilter);
        return acknowledge(true, { epoch: args.epoch, expiresAt, releasedAt: null });
      }
      case 'release': {
        // Only the caller's own lease can be released, and only with a current
        // epoch (reordering safety). Idempotent for an already-released lease.
        const own = await readOwnLease(true);
        if (own && own.epoch > args.epoch) return acknowledge(false, own);
        if (!own) {
          // Release-before-first-acquire (two concurrent operations arriving
          // reordered): record a released TOMBSTONE so the DELAYED acquire
          // with its lower epoch cannot resurrect a hold the client already
          // gave up. The upsert guard settles the race with that acquire
          // committing between our read and this insert: the higher epoch wins.
          const [written] = await tx
            .insert(sessionLoopLeases)
            .values({
              activitySessionId: args.sessionId,
              clientId: args.clientId,
              epoch: args.epoch,
              expiresAt: now,
              releasedAt: now,
            })
            .onConflictDoUpdate({
              target: [sessionLoopLeases.activitySessionId, sessionLoopLeases.clientId],
              set: { epoch: args.epoch, releasedAt: now },
              setWhere: sql`${sessionLoopLeases.epoch} <= ${args.epoch}`,
            })
            .returning({ epoch: sessionLoopLeases.epoch });
          // No cached row shape here: when the guard lost to a higher-epoch
          // concurrent acquire, the truthful own-lease state is that acquire's.
          return acknowledge(written !== undefined);
        }
        await tx
          .update(sessionLoopLeases)
          .set({ epoch: args.epoch, releasedAt: now })
          .where(ownLeaseFilter);
        return acknowledge(true, { epoch: args.epoch, expiresAt: own.expiresAt, releasedAt: now });
      }
    }
  });
}

/**
 * Whether the session currently holds ANY unexpired, unreleased loop lease —
 * the predicate the buffer sweep consults before paid prefill (it runs
 * inside the sweep's owner-lock transaction, hence `DbOrTx`).
 */
export async function hasLiveLoopLease(
  db: DbOrTx,
  args: { sessionId: string; now?: Date },
): Promise<boolean> {
  return sessionHeld(db, args.sessionId, args.now ?? new Date());
}
