// Invite/reset/confirm link rows: mint, list, revoke, and the one-shot consume.
//
// Consumption is a single conditional UPDATE gated on `consumed_at IS NULL`
// (and unrevoked, unexpired) — under concurrency Postgres serializes the two
// row updates, so exactly one caller ever receives the row back. Callers never
// look tokens up any other way; unknown, expired, revoked, and consumed all
// come back as the same `null`, which is what keeps refusals opaque.

import { and, desc, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import type { MemberLimits } from '@liedmotif/shared';
import type { Database } from '../client';
import { withTransaction, type DbOrTx, type Transaction } from '../transactions';
import { invites, type InviteKind, type InviteRow } from '../schema';
import { generateLinkToken, hashLinkToken } from './token';

/** Default life of a Member invite link (spec: 7 days). */
export const MEMBER_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
/** Password-reset links are handed over for immediate use; one day is plenty. */
export const PASSWORD_RESET_TTL_MS = 24 * 60 * 60 * 1_000;
/** A mailed reset link rests in an inbox anyone with the mailbox can read; one hour. */
export const EMAILED_PASSWORD_RESET_TTL_MS = 60 * 60 * 1_000;
/** Email-confirm links wait in an inbox; a day covers a mail read the next morning. */
export const EMAIL_CONFIRM_TTL_MS = 24 * 60 * 60 * 1_000;

export interface MintedLink {
  invite: InviteRow;
  /** The URL secret — shown to the Admin once, never stored or logged. */
  token: string;
}

/**
 * Mint a Member invite. With `email` the Invite is bound to that address: the
 * claim takes it as the Member's login, already confirmed. Stored lowercased,
 * the form Better Auth's sign-in matches exactly.
 */
export async function createMemberInvite(
  db: DbOrTx,
  input: {
    label: string;
    budget: MemberLimits;
    email?: string;
    createdByUserId: string;
    expiresAt?: Date;
    now?: Date;
  },
): Promise<MintedLink> {
  const now = input.now ?? new Date();
  const { token, tokenHash } = generateLinkToken();
  const [invite] = await db
    .insert(invites)
    .values({
      kind: 'member_invite',
      label: input.label.trim(),
      tokenHash,
      budget: input.budget,
      email: input.email?.trim().toLowerCase(),
      createdByUserId: input.createdByUserId,
      expiresAt: input.expiresAt ?? new Date(now.getTime() + MEMBER_INVITE_TTL_MS),
    })
    .returning();
  return { invite: invite!, token };
}

/**
 * Mint a link that sets a new password for its target, voiding the target's
 * older open reset links in the same transaction — copied and mailed ones
 * alike — so only the newest link works.
 */
export async function createPasswordResetLink(
  db: Database,
  input: {
    targetUserId: string;
    label: string;
    createdByUserId: string;
    /** Defaults to `PASSWORD_RESET_TTL_MS`, the copy-link lifetime. */
    ttlMs?: number;
    now?: Date;
  },
): Promise<MintedLink> {
  const now = input.now ?? new Date();
  const { token, tokenHash } = generateLinkToken();
  return withTransaction(db, async (tx) => {
    await voidOpenLinks(tx, { kind: 'password_reset', targetUserId: input.targetUserId, now });
    const [invite] = await tx
      .insert(invites)
      .values({
        kind: 'password_reset',
        label: input.label.trim(),
        tokenHash,
        targetUserId: input.targetUserId,
        createdByUserId: input.createdByUserId,
        expiresAt: new Date(now.getTime() + (input.ttlMs ?? PASSWORD_RESET_TTL_MS)),
      })
      .returning();
    return { invite: invite!, token };
  });
}

/**
 * Mint a link that confirms `email` for its own User, voiding that User's older
 * open confirm links in the same transaction, so only the newest mail works. The
 * address doubles as the label: it is who the link is for.
 */
export async function createEmailConfirmLink(
  db: Database,
  input: { targetUserId: string; email: string; now?: Date },
): Promise<MintedLink> {
  const now = input.now ?? new Date();
  const { token, tokenHash } = generateLinkToken();
  return withTransaction(db, async (tx) => {
    await voidOpenLinks(tx, { kind: 'email_confirm', targetUserId: input.targetUserId, now });
    const [invite] = await tx
      .insert(invites)
      .values({
        kind: 'email_confirm',
        label: input.email,
        tokenHash,
        targetUserId: input.targetUserId,
        email: input.email,
        createdByUserId: input.targetUserId,
        expiresAt: new Date(now.getTime() + EMAIL_CONFIRM_TTL_MS),
      })
      .returning();
    return { invite: invite!, token };
  });
}

/** Unconsumed, unrevoked, unexpired — the single definition of "still live". */
function openCondition(now: Date) {
  return and(isNull(invites.consumedAt), isNull(invites.revokedAt), gt(invites.expiresAt, now));
}

/** Revoke every still-live link of one kind that acts on `targetUserId`. */
export async function voidOpenLinks(
  db: DbOrTx,
  input: { kind: InviteKind; targetUserId: string; now: Date },
): Promise<void> {
  await db
    .update(invites)
    .set({ revokedAt: input.now })
    .where(
      and(
        eq(invites.kind, input.kind),
        eq(invites.targetUserId, input.targetUserId),
        openCondition(input.now),
      ),
    );
}

/** The still-claimable predicate — the single definition of "this link works". */
function claimableCondition(kind: InviteKind, tokenHash: string, now: Date) {
  return and(eq(invites.tokenHash, tokenHash), eq(invites.kind, kind), openCondition(now));
}

/**
 * Spend a Member invite: stamps `consumed_at` and returns the budget the claim
 * must snapshot, exactly once. Must run inside the caller's transaction so a
 * failed claim un-spends it.
 *
 * The budget is part of what makes the row CLAIMABLE, not something the caller
 * checks afterwards: a `member_invite` without one cannot produce a Member, and
 * matching it in the predicate means such a row is refused without burning its
 * token — a post-consume check would spend the link and then reject it.
 */
export async function consumeMemberInvite(
  tx: Transaction,
  input: { tokenHash: string; now: Date },
): Promise<{ id: string; budget: MemberLimits; email: string | null } | null> {
  const [row] = await tx
    .update(invites)
    .set({ consumedAt: input.now })
    .where(
      and(
        claimableCondition('member_invite', input.tokenHash, input.now),
        isNotNull(invites.budget),
      ),
    )
    .returning({ id: invites.id, budget: invites.budget, email: invites.email });
  // `budget` is non-null by the predicate above; this narrows it for the caller.
  return row?.budget ? { id: row.id, budget: row.budget, email: row.email } : null;
}

/**
 * Spend a password-reset link and return whose credential it rotates. Same rule
 * as `consumeMemberInvite`: a row without a target cannot rotate anything, so it
 * never matches and never burns.
 */
export async function consumePasswordResetLink(
  tx: Transaction,
  input: { tokenHash: string; now: Date },
): Promise<{ id: string; targetUserId: string } | null> {
  const [row] = await tx
    .update(invites)
    .set({ consumedAt: input.now })
    .where(
      and(
        claimableCondition('password_reset', input.tokenHash, input.now),
        isNotNull(invites.targetUserId),
      ),
    )
    .returning({ id: invites.id, targetUserId: invites.targetUserId });
  // `targetUserId` is non-null by the predicate above; this narrows it.
  return row?.targetUserId ? { id: row.id, targetUserId: row.targetUserId } : null;
}

/**
 * Spend an email-confirm link and return whose address it confirms. Same rule
 * as the other consumes: a row without a target or an address never matches.
 */
export async function consumeEmailConfirmLink(
  tx: Transaction,
  input: { tokenHash: string; now: Date },
): Promise<{ id: string; targetUserId: string; email: string } | null> {
  const [row] = await tx
    .update(invites)
    .set({ consumedAt: input.now })
    .where(
      and(
        claimableCondition('email_confirm', input.tokenHash, input.now),
        isNotNull(invites.targetUserId),
        isNotNull(invites.email),
      ),
    )
    .returning({ id: invites.id, targetUserId: invites.targetUserId, email: invites.email });
  // Both are non-null by the predicate above; this narrows them.
  return row?.targetUserId && row.email
    ? { id: row.id, targetUserId: row.targetUserId, email: row.email }
    : null;
}

/** Claim/reset/confirm-page lookup: the link's label and address, if (and only if) it works. */
export async function findClaimableLink(
  db: DbOrTx,
  input: { kind: InviteKind; token: string; now?: Date },
): Promise<{ id: string; label: string; email: string | null } | null> {
  const [row] = await db
    .select({ id: invites.id, label: invites.label, email: invites.email })
    .from(invites)
    .where(claimableCondition(input.kind, hashLinkToken(input.token), input.now ?? new Date()))
    .limit(1);
  return row ?? null;
}

export interface OpenInvite {
  id: string;
  label: string;
  /** The address an emailed Invite was sent to; null for a copy-link one. */
  email: string | null;
  createdAt: Date;
  expiresAt: Date;
}

/** Outstanding (claimable) Member invites, newest first, for Settings → Members. */
export async function listOpenMemberInvites(
  db: DbOrTx,
  now: Date = new Date(),
): Promise<OpenInvite[]> {
  return db
    .select({
      id: invites.id,
      label: invites.label,
      email: invites.email,
      createdAt: invites.createdAt,
      expiresAt: invites.expiresAt,
    })
    .from(invites)
    .where(and(eq(invites.kind, 'member_invite'), openCondition(now)))
    .orderBy(desc(invites.createdAt));
}

/** Revoke an unconsumed link. Returns false when it was already spent or revoked. */
export async function revokeInvite(
  db: DbOrTx,
  input: { id: string; now?: Date },
): Promise<boolean> {
  const rows = await db
    .update(invites)
    .set({ revokedAt: input.now ?? new Date() })
    .where(and(eq(invites.id, input.id), isNull(invites.consumedAt), isNull(invites.revokedAt)))
    .returning({ id: invites.id });
  return rows.length > 0;
}
