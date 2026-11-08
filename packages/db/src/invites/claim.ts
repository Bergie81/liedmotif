// The atomic Member claim, the one-shot password reset, and the
// email confirm.
//
// Claiming runs as ONE transaction: consume the invite (conditional update),
// insert the Better Auth `user` + credential `account`, insert the member
// profile, snapshot the invite's budget, provision the owner Person. Any
// failure — most importantly a duplicate email — rolls the consumption back,
// so the link stays claimable. Better Auth's `user.create` hooks never run
// here: this path does not go through Better Auth, and the single-admin lock
// refuses every Better Auth signup on its own. The member role is a literal;
// no input can escalate it.
//
// An emailed Invite brings its own address: the claimer's typed one is
// ignored, and the address is a Confirmed email from the start, since only its
// inbox ever held the link.

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { isEmailUniqueViolation } from '../pg-errors';
import { withTransaction } from '../transactions';
import { invites, user, userProfiles } from '../schema';
import { deleteLogins } from '../logins';
import { ensureOwnerPersonInTx } from '../people/people-repo';
import { updateMemberLimits } from '../settings/user-settings-repo';
import {
  consumeEmailConfirmLink,
  consumeMemberInvite,
  consumePasswordResetLink,
} from './invites-repo';
import { hashLinkToken } from './token';
import { defaultHashPassword, upsertCredentialPassword } from './credential';

export type ClaimMemberInviteResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; reason: 'invalid_token' | 'email_in_use' };

export type ResetPasswordWithTokenResult =
  { ok: true; userId: string } | { ok: false; reason: 'invalid_token' };

export type ConfirmEmailWithTokenResult = ResetPasswordWithTokenResult;

export async function claimMemberInvite(
  db: Database,
  input: {
    token: string;
    name: string;
    /** The claimer's chosen login; ignored when the Invite carries its own. */
    email: string;
    password: string;
    /** Injectable for tests; defaults to Better Auth's scrypt hasher. */
    hashPassword?: (password: string) => Promise<string>;
    now?: Date;
  },
): Promise<ClaimMemberInviteResult> {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  // Hash outside the transaction: scrypt is deliberately slow, and the work is
  // wasted at worst — never a lock held across it.
  const passwordHash = await (input.hashPassword ?? defaultHashPassword)(input.password);

  let result: ClaimMemberInviteResult;
  try {
    result = await withTransaction(db, async (tx) => {
      const invite = await consumeMemberInvite(tx, {
        tokenHash: hashLinkToken(input.token),
        now,
      });
      if (!invite) return { ok: false as const, reason: 'invalid_token' as const };

      const userId = randomUUID();
      const login = invite.email ?? email;
      await tx
        .insert(user)
        .values({ id: userId, name, email: login, emailVerified: invite.email !== null });
      await upsertCredentialPassword(tx, userId, passwordHash);
      await tx.insert(userProfiles).values({ userId, role: 'member' });
      // A One-time budget counts from its Grant, and a Member's Grant is the
      // moment they became one — the invite's own stamp only dates the mint.
      const budget =
        invite.budget.kind === 'oneTime'
          ? { ...invite.budget, grantedAt: now.toISOString() }
          : invite.budget;
      await updateMemberLimits(tx, { ownerUserId: userId, patch: budget });
      // Same pairing as `createAdminProfile`: every account gets its owner
      // Person (and the no-name fallback) at creation — inside the claim
      // transaction, so a Member can never exist without one.
      await ensureOwnerPersonInTx(tx, userId);
      await tx.update(invites).set({ consumedByUserId: userId }).where(eq(invites.id, invite.id));
      return { ok: true as const, userId, email: login };
    });
  } catch (error) {
    if (isEmailUniqueViolation(error)) {
      return { ok: false, reason: 'email_in_use' };
    }
    throw error;
  }
  return result;
}

/**
 * Spend a reset link and rotate the target user's password, atomically —
 * revoking the target's live Logins in the same transaction. Recovery exists to
 * take the account back from whoever has it, and a rotated password does not do
 * that on its own: authorization re-reads role and disabled state per request,
 * never the credential, so a stolen cookie outlives the rotation until its
 * Login row is gone.
 */
export async function resetPasswordWithToken(
  db: Database,
  input: {
    token: string;
    newPassword: string;
    hashPassword?: (password: string) => Promise<string>;
    now?: Date;
  },
): Promise<ResetPasswordWithTokenResult> {
  const now = input.now ?? new Date();
  const passwordHash = await (input.hashPassword ?? defaultHashPassword)(input.newPassword);

  return withTransaction(db, async (tx) => {
    const link = await consumePasswordResetLink(tx, {
      tokenHash: hashLinkToken(input.token),
      now,
    });
    if (!link) return { ok: false as const, reason: 'invalid_token' as const };

    await upsertCredentialPassword(tx, link.targetUserId, passwordHash);
    await deleteLogins(tx, link.targetUserId);
    await tx
      .update(invites)
      .set({ consumedByUserId: link.targetUserId })
      .where(eq(invites.id, link.id));
    return { ok: true as const, userId: link.targetUserId };
  });
}

/**
 * Spend an email-confirm link and mark the target's address confirmed — but
 * only while the account still has the address the link was mailed to. The
 * address check sits on the confirming write itself, so an email change that
 * commits between the consume and this write can never be confirmed by a link
 * mailed to the old address. A mismatch spends the link and answers like any
 * dead one: a link to an address the account has left can confirm nothing.
 */
export async function confirmEmailWithToken(
  db: Database,
  input: { token: string; now?: Date },
): Promise<ConfirmEmailWithTokenResult> {
  const now = input.now ?? new Date();
  return withTransaction(db, async (tx) => {
    const link = await consumeEmailConfirmLink(tx, {
      tokenHash: hashLinkToken(input.token),
      now,
    });
    if (!link) return { ok: false as const, reason: 'invalid_token' as const };

    const confirmed = await tx
      .update(user)
      .set({ emailVerified: true })
      .where(and(eq(user.id, link.targetUserId), sql`lower(${user.email}) = lower(${link.email})`))
      .returning({ id: user.id });
    if (confirmed.length === 0) return { ok: false as const, reason: 'invalid_token' as const };

    await tx
      .update(invites)
      .set({ consumedByUserId: link.targetUserId })
      .where(eq(invites.id, link.id));
    return { ok: true as const, userId: link.targetUserId };
  });
}
