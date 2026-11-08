// Logins — the Better Auth `session` rows a browser cookie is backed by
// (the auth login is a Login; a bare "Session" is always the music
// aggregate). Better Auth's table keeps its vendor name; nothing else here does.

import { and, eq, ne } from 'drizzle-orm';
import { session } from './schema';
import type { DbOrTx } from './transactions';

/**
 * Revoke every live Login a user holds. Composable into a caller's transaction,
 * which is the whole point on the recovery paths: a rotated credential and the
 * eviction it exists FOR must commit together, or account recovery hands the
 * account back to whoever still holds a live cookie.
 *
 * Revocation is not instant — `session.cookieCache` answers `getSession` from a
 * signed cookie for its `maxAge` after the row is gone (that window is why the
 * cache is kept short).
 */
export async function deleteLogins(db: DbOrTx, userId: string): Promise<void> {
  await db.delete(session).where(eq(session.userId, userId));
}

/**
 * Revoke every Login a user holds EXCEPT the one identified by `keepToken` —
 * the browser making the change stays signed in, everything else is evicted.
 * Same transactional rule as `deleteLogins`: the change that motivates the
 * eviction and the eviction itself belong in one commit.
 */
export async function deleteOtherLogins(
  db: DbOrTx,
  userId: string,
  keepToken: string,
): Promise<void> {
  await db.delete(session).where(and(eq(session.userId, userId), ne(session.token, keepToken)));
}
