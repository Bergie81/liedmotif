// The one role-resolution seam. Every "who is this user?" question — guard
// checks, role-gated pages, disable enforcement — goes through
// `resolveUserProfile`; there must not be a second way to ask. Role and
// disabled state are resolved from the database per call, never from a session
// cookie, so a disable takes effect immediately regardless of cookie caches.

import { eq } from 'drizzle-orm';
import { user, userProfiles } from '../schema';
import type { DbOrTx } from '../transactions';

/** The two roles an Instance knows. Exactly one user holds `admin`. */
export type UserRole = 'admin' | 'member';

export interface UserProfile {
  role: UserRole;
  /** Set when the account is disabled: sign-in and spend are blocked. */
  disabledAt: Date | null;
}

/** Role + disabled state for a user, or `null` when no profile row exists. */
export async function resolveUserProfile(db: DbOrTx, userId: string): Promise<UserProfile | null> {
  const rows = await db
    .select({ role: userProfiles.role, disabledAt: userProfiles.disabledAt })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { role: row.role as UserRole, disabledAt: row.disabledAt };
}

/**
 * Every admin account's id and email. `user_profiles` holds BOTH roles, so a
 * query over the whole table is a query over the Members too — the `role`
 * predicate is what makes this admins, and it lives here beside the seam rather
 * than being re-spelled by each caller.
 */
export async function listAdmins(db: DbOrTx): Promise<Array<{ id: string; email: string }>> {
  return db
    .select({ id: user.id, email: user.email })
    .from(userProfiles)
    .innerJoin(user, eq(user.id, userProfiles.userId))
    .where(eq(userProfiles.role, 'admin'));
}
