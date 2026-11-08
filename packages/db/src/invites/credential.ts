// Email/password credential writes shared by the claim, reset, and own
// password-change flows.
//
// Better Auth stores the password on the `account` row under provider id
// `credential`, hashed with its own scrypt hasher — writing through anything
// else would produce a hash sign-in cannot verify. The hasher is lazily
// imported so modules that only read never load Better Auth's runtime.

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { deleteOtherLogins } from '../logins';
import { withTransaction, type DbOrTx } from '../transactions';
import { account } from '../schema';

/** Better Auth stores email/password credentials under this account provider id. */
export const CREDENTIAL_PROVIDER_ID = 'credential';

/** Default hasher: Better Auth's own scrypt, lazily imported. */
export async function defaultHashPassword(password: string): Promise<string> {
  const { hashPassword } = await import('better-auth/crypto');
  return hashPassword(password);
}

/**
 * Does this plaintext password match the user's stored credential? Fails CLOSED:
 * a user with no credential account (or no password on it) verifies as false, so
 * a caller re-confirming an identity never mistakes "nothing to check" for a
 * pass. Verification uses Better Auth's own scrypt so it agrees with sign-in.
 */
export async function verifyCredentialPassword(
  db: DbOrTx,
  userId: string,
  password: string,
): Promise<boolean> {
  const [existing] = await db
    .select({ password: account.password })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, CREDENTIAL_PROVIDER_ID)))
    .limit(1);
  if (!existing?.password) return false;
  const { verifyPassword } = await import('better-auth/crypto');
  return verifyPassword({ hash: existing.password, password });
}

/**
 * Overwrite (or create) the user's credential-account password with an
 * ALREADY-HASHED value. Composable into a caller's transaction so a one-shot
 * reset token is spent and the password rotated atomically.
 */
export async function upsertCredentialPassword(
  db: DbOrTx,
  userId: string,
  passwordHash: string,
): Promise<void> {
  const [existing] = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, CREDENTIAL_PROVIDER_ID)))
    .limit(1);

  if (existing) {
    await db.update(account).set({ password: passwordHash }).where(eq(account.id, existing.id));
    return;
  }
  await db.insert(account).values({
    id: randomUUID(),
    accountId: userId,
    providerId: CREDENTIAL_PROVIDER_ID,
    userId,
    password: passwordHash,
  });
}

/**
 * A signed-in user's own password change: rotate the credential and revoke
 * every Login except `keepLoginToken` (the browser asking), in one transaction.
 * A live cookie outlives a rotated password, so the revocation is what evicts
 * whoever holds another browser's, and the two never commit apart. The caller
 * has already verified the current password and enforced the policy on the new
 * one.
 */
export async function changeOwnPassword(
  db: Database,
  input: { userId: string; newPassword: string; keepLoginToken: string },
): Promise<void> {
  const passwordHash = await defaultHashPassword(input.newPassword);
  await withTransaction(db, async (tx) => {
    await upsertCredentialPassword(tx, input.userId, passwordHash);
    await deleteOtherLogins(tx, input.userId, input.keepLoginToken);
  });
}
