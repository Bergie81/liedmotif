// Serialize first-run setup with a Postgres advisory lock.
//
// The single-admin invariant is already enforced (the Better Auth
// `user.create.before` hook + the `user_profiles_single_admin` partial unique
// index). This adds RACE hardening for the owner-less config/credential writes:
// without it, two concurrent first-run submits can both pass the logical
// `assertCanCreateAdmin` pre-check, and the loser could overwrite the winner's
// instance config before its sign-up is rejected.
//
// `withSetupAdvisoryLock` runs `fn` while holding a transaction-scoped advisory
// lock (`pg_advisory_xact_lock`) on a dedicated connection. A second setup blocks
// at the lock until the first's transaction ends, so the loser sees the admin
// already exists and writes nothing. The advisory lock is a global mutex (not a
// row lock), so `fn` runs its own queries on the normal pool as usual.

import type { Pool } from 'pg';

/**
 * Stable advisory-lock key for first-run setup serialization (arbitrary constant).
 * This is the single-key space (`pg_advisory_xact_lock(bigint)`), distinct from
 * the class/key locks catalogued in `../advisory-locks.ts` — see that registry
 * before adding any new advisory lock.
 */
export const SETUP_ADVISORY_LOCK_KEY = 481723;

export async function withSetupAdvisoryLock<T>(pool: Pool, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // This connection is the one place that deliberately blocks on a lock and
    // then sits idle in its transaction for the WHOLE critical section — admin
    // sign-up, instance config, and a placeholder-cover upload that may cross a
    // network. The web pool's request-sized ceilings would abort exactly that,
    // turning a legitimate first-run setup into a failed one, so this
    // transaction opts out of all three (`SET LOCAL` ends with it).
    await client.query(
      'SET LOCAL statement_timeout = 0; SET LOCAL lock_timeout = 0; SET LOCAL idle_in_transaction_session_timeout = 0',
    );
    // Blocks here until any concurrent holder's transaction ends.
    await client.query('SELECT pg_advisory_xact_lock($1)', [SETUP_ADVISORY_LOCK_KEY]);
    const result = await fn();
    await client.query('COMMIT'); // releases the advisory lock
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
