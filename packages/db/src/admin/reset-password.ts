// No-email admin password recovery.
//
// Account email is optional, so the admin can always recover a lost password
// through local server/container access. This is the logic behind the
// `docker compose exec ... reset-admin-password` CLI: find the single admin, hash
// the new password with Better Auth's OWN hasher (so the result verifies at
// sign-in), and overwrite the credential account's password. It returns only
// non-secret identity fields and never logs/returns the password — the CLI emits a
// safe audit line via the shared logger.

import { validatePassword } from '@liedmotif/shared';
import type { Database } from '../client';
import { defaultHashPassword, upsertCredentialPassword } from '../invites/credential';
import { deleteLogins } from '../logins';
import { listAdmins } from '../profile/resolve-user-profile';
import { withTransaction } from '../transactions';

/** Thrown when no admin matches the request. */
export class AdminNotFoundError extends Error {
  constructor(message = 'No matching admin found') {
    super(message);
    this.name = 'AdminNotFoundError';
  }
}

/** Thrown when the requested new password fails the shared password policy. */
export class WeakPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeakPasswordError';
  }
}

export interface ResetAdminPasswordInput {
  /** Optional: the admin's email. Omit to target the single admin. */
  email?: string;
  newPassword: string;
  /**
   * Password hasher, injectable for tests. Defaults to Better Auth's scrypt hasher
   * so the stored hash verifies through the normal sign-in path.
   */
  hashPassword?: (password: string) => Promise<string>;
}

/**
 * Find the target admin (by email, or the single admin when no email is given).
 * Admins only: `user_profiles` holds Members too, and this recovery path must
 * never resolve — or rotate the password of — a Member account.
 */
async function findAdmin(db: Database, email?: string): Promise<{ id: string; email: string }> {
  const admins = await listAdmins(db);

  if (email) {
    const match = admins.find((a) => a.email.toLowerCase() === email.trim().toLowerCase());
    if (!match) throw new AdminNotFoundError(`No admin with email ${email}`);
    return match;
  }

  if (admins.length === 0) throw new AdminNotFoundError('No admin exists yet');
  if (admins.length > 1) {
    throw new AdminNotFoundError('Multiple admins found; pass --email to disambiguate');
  }
  return admins[0]!;
}

/**
 * Rotate the admin's password and revoke their live Logins, in one transaction.
 * Returns the admin's id + email (never the password). Throws `WeakPasswordError`
 * / `AdminNotFoundError` on bad input.
 *
 * The revocation is what makes this recovery rather than a password change: an
 * operator reaches for it precisely when the account may be held by someone
 * else, and authorization re-reads role and disabled state per request — never
 * the credential — so a live cookie survives a rotation on its own.
 */
export async function resetAdminPassword(
  db: Database,
  input: ResetAdminPasswordInput,
): Promise<{ userId: string; email: string }> {
  const passwordError = validatePassword(input.newPassword);
  if (passwordError) throw new WeakPasswordError(passwordError);

  const admin = await findAdmin(db, input.email);
  const hash = await (input.hashPassword ?? defaultHashPassword)(input.newPassword);
  await withTransaction(db, async (tx) => {
    await upsertCredentialPassword(tx, admin.id, hash);
    await deleteLogins(tx, admin.id);
  });

  return { userId: admin.id, email: admin.email };
}
