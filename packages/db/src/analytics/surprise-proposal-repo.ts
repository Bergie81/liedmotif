// The owner's one pending Surprise Me proposal. Storing one is
// guarded twice: by the personalization epoch it was requested under, so a
// reset, a history clearing or a Personalize suggestions change outruns any
// text-LLM call still in flight; and by the identity the caller saw, so a stale
// tab can neither replace nor dismiss a proposal it never showed.

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { listeningPreferences, surpriseProposals } from '../schema';
import { withTransaction, type Transaction } from '../transactions';
import { withOwnerGenerationLock } from '../generation/limits-repo';
import {
  createSessionInTx,
  getSessionById,
  type CreateSessionInput,
  type CreateSessionResult,
} from '../generation/session-command-repo';
import { ensurePreferences } from './listening-repo';

export type SurpriseProposalRow = typeof surpriseProposals.$inferSelect;
export type SurpriseProposalDraft = Omit<
  SurpriseProposalRow,
  'id' | 'ownerUserId' | 'createdAt' | 'startedSessionId'
>;

/** Pending = not yet started; a started row is only a retry marker. */
const isPending = isNull(surpriseProposals.startedSessionId);

export async function getPendingProposal(
  db: Database | Transaction,
  ownerUserId: string,
): Promise<SurpriseProposalRow | null> {
  const [row] = await db
    .select()
    .from(surpriseProposals)
    .where(and(eq(surpriseProposals.ownerUserId, ownerUserId), isPending));
  return row ?? null;
}

/** What a proposal request must capture before it spends anything. */
export async function getProposalContext(
  db: Database,
  ownerUserId: string,
): Promise<{
  epoch: number;
  pendingId: string | null;
  /** What Try another must steer away from; null without a pending proposal. */
  pending: { intent: string; situation: string | null; skipProfile: boolean } | null;
}> {
  await ensurePreferences(db, ownerUserId);
  const [row] = await db
    .select({
      epoch: listeningPreferences.proposalEpoch,
      pendingId: surpriseProposals.id,
      intent: surpriseProposals.intent,
      preview: surpriseProposals.preview,
      skipProfile: surpriseProposals.skipProfile,
    })
    .from(listeningPreferences)
    .leftJoin(
      surpriseProposals,
      and(eq(surpriseProposals.ownerUserId, listeningPreferences.ownerUserId), isPending),
    )
    .where(eq(listeningPreferences.ownerUserId, ownerUserId));
  return {
    epoch: row?.epoch ?? 0,
    pendingId: row?.pendingId ?? null,
    pending:
      row?.pendingId && row.intent != null
        ? {
            intent: row.intent,
            situation: row.preview?.situation ?? null,
            skipProfile: row.skipProfile ?? false,
          }
        : null,
  };
}

export type SaveProposalResult =
  | { ok: true; proposal: SurpriseProposalRow }
  | {
      ok: false;
      /** `context_changed`: the epoch moved. `superseded`: `replaces` is not the pending proposal. */
      reason: 'context_changed' | 'superseded';
      current: SurpriseProposalRow | null;
    };

/**
 * Store `draft` as the pending proposal, replacing exactly the one the caller
 * saw (`replaces`, or null for none). The preferences row lock serializes this
 * against every invalidation and every other save for the owner.
 */
export async function savePendingProposal(
  db: Database,
  input: {
    ownerUserId: string;
    epoch: number;
    replaces: string | null;
    draft: SurpriseProposalDraft;
  },
): Promise<SaveProposalResult> {
  return withTransaction(db, async (tx) => {
    await ensurePreferences(tx, input.ownerUserId);
    const [preferences] = await tx
      .select({ epoch: listeningPreferences.proposalEpoch })
      .from(listeningPreferences)
      .where(eq(listeningPreferences.ownerUserId, input.ownerUserId))
      .for('update');
    const current = await getPendingProposal(tx, input.ownerUserId);
    if (preferences?.epoch !== input.epoch)
      return { ok: false, reason: 'context_changed', current };
    if ((current?.id ?? null) !== input.replaces)
      return { ok: false, reason: 'superseded', current };
    await tx.delete(surpriseProposals).where(eq(surpriseProposals.ownerUserId, input.ownerUserId));
    const [proposal] = await tx
      .insert(surpriseProposals)
      .values({ ...input.draft, ownerUserId: input.ownerUserId })
      .returning();
    return { ok: true, proposal: proposal! };
  });
}

/** Dismiss the pending proposal if it is still the one named. */
export async function dismissPendingProposal(
  db: Database,
  input: { ownerUserId: string; proposalId: string },
): Promise<boolean> {
  const removed = await db
    .delete(surpriseProposals)
    .where(
      and(
        eq(surpriseProposals.ownerUserId, input.ownerUserId),
        eq(surpriseProposals.id, input.proposalId),
        isPending,
      ),
    )
    .returning({ id: surpriseProposals.id });
  return removed.length > 0;
}

/** The owner's proposal under this identity, pending or already started. */
export async function getProposalById(
  db: Database | Transaction,
  input: { ownerUserId: string; proposalId: string },
): Promise<SurpriseProposalRow | null> {
  const [row] = await db
    .select()
    .from(surpriseProposals)
    .where(
      and(
        eq(surpriseProposals.ownerUserId, input.ownerUserId),
        eq(surpriseProposals.id, input.proposalId),
      ),
    );
  return row ?? null;
}

/** What the caller decides for a started proposal; the musical identity is the row's. */
export type ProposalSessionOptions = Pick<
  CreateSessionInput,
  | 'sessionMode'
  | 'targetDurationMinutes'
  | 'coverImageId'
  | 'coverStyle'
  | 'coverStyleHint'
  | 'useStandardCover'
  | 'now'
>;

export type StartProposalResult =
  | (CreateSessionResult & { ok: true; alreadyStarted: boolean })
  /** Replaced, dismissed, invalidated, or never this owner's. */
  | { ok: false; reason: 'not_pending' };

/**
 * Start the named proposal as a Session, exactly once. The Session insert and
 * the started marker commit together under the owner generation lock, and the
 * proposal row is locked against replacement and invalidation, so a retried or
 * concurrent start finds the marker and returns the Session already created.
 * The Style Snapshot, naming and request text come from the locked row — never
 * from the caller.
 */
export async function startProposalSession(
  db: Database,
  input: { ownerUserId: string; proposalId: string; session: ProposalSessionOptions },
): Promise<StartProposalResult> {
  const { ownerUserId, proposalId } = input;
  return withOwnerGenerationLock(db, ownerUserId, async (tx) => {
    const [proposal] = await tx
      .select()
      .from(surpriseProposals)
      .where(
        and(eq(surpriseProposals.ownerUserId, ownerUserId), eq(surpriseProposals.id, proposalId)),
      )
      .for('update');
    if (!proposal) return { ok: false as const, reason: 'not_pending' as const };

    if (proposal.startedSessionId) {
      const session = await getSessionById(tx, {
        ownerUserId,
        sessionId: proposal.startedSessionId,
      });
      // The marker answers a retry of the Start that bought the Session; once
      // that Session is stopped or being deleted, the Start is stale, not a retry.
      if (!session || session.status !== 'active' || session.deleteRequestedAt) {
        return { ok: false as const, reason: 'not_pending' as const };
      }
      return { ok: true as const, alreadyStarted: true, session, supersededSessionId: null };
    }

    const created = await createSessionInTx(tx, {
      ...input.session,
      ownerUserId,
      snapshot: proposal.snapshot,
      title: proposal.title,
      coverConcept: proposal.coverConcept,
      // Every proposal is prompt-born: its request is the Session's direction.
      userPrompt: proposal.intent,
      structuredControls: null,
      ...(proposal.skipProfile ? { skipProfile: true } : {}),
    });
    await tx
      .update(surpriseProposals)
      .set({ startedSessionId: created.session.id })
      .where(eq(surpriseProposals.id, proposal.id));
    return { ok: true as const, alreadyStarted: false, ...created };
  });
}

/**
 * The owner's personalization context changed: drop the pending proposal and
 * advance the epoch inside the caller's transaction, so nothing requested
 * before the change can be stored after it.
 */
export async function invalidateProposalsInTx(tx: Transaction, ownerUserId: string): Promise<void> {
  await ensurePreferences(tx, ownerUserId);
  await tx.execute(sql`
    update ${listeningPreferences} set proposal_epoch = proposal_epoch + 1
    where owner_user_id = ${ownerUserId}
  `);
  await tx.delete(surpriseProposals).where(eq(surpriseProposals.ownerUserId, ownerUserId));
}
