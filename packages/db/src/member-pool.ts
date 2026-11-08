// The spend scope a count is taken in. Every budgeted count — music
// tasks and covers alike — is the same predicate widened by owner set, so a
// per-owner number and the Pool number can never drift from two separate rules.

import { notExists, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { userProfiles } from './schema';

/**
 * Whose spend a count covers: one owner's, or the whole Members Pool's. Passed
 * as a value rather than answered by a second function per count, so adding a
 * scope is a case here instead of a parallel export everywhere.
 */
export type SpendScope = { kind: 'owner'; ownerUserId: string } | { kind: 'pool' };

/** The Members Pool scope — one Pool per instance, so it carries no key. */
export const POOL_SCOPE: SpendScope = { kind: 'pool' };

/** One owner's own scope. */
export function ownerScope(ownerUserId: string): SpendScope {
  return { kind: 'owner', ownerUserId };
}

/**
 * Matches rows in `scope`. The Pool branch is deliberately "owner is NOT an
 * admin" rather than "owner is a member": the Admin's spend is never in the Pool
 * count, while a DELETED Member's surviving rows — whose owner has no profile row
 * anymore, or is null after the ledger's set-null cascade — keep counting until
 * their window rolls over, so delete-and-recreate cannot reset the Pool.
 *
 * A caller whose owner expression is also null for rows that are nobody's spend
 * (an instance-global cover) must exclude those in its own base predicate; this
 * condition cannot tell the two kinds of null apart.
 */
export function spendScopeCondition(scope: SpendScope, owner: AnyPgColumn | SQL): SQL {
  if (scope.kind === 'owner') return sql`${owner} = ${scope.ownerUserId}`;
  return notExists(
    sql`(select 1 from ${userProfiles} where ${userProfiles.userId} = ${owner} and ${userProfiles.role} = 'admin')`,
  );
}
