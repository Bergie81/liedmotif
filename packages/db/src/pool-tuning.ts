// Per-role connection-pool sizing and session timeouts.
//
// Without a `statement_timeout` one bad plan holds a connection until the
// backend dies: ten of those exhaust the web pool and every API request then
// fails at the acquire timeout with nothing able to break the stuck queries.
// The web pool is therefore bounded well inside a request's patience, while the
// worker's is sized for the jobs it documents (downloads bounded at 120s,
// analysis longer) — a request-sized ceiling there would abort work already
// paid for. `lock_timeout` bounds waiting for a lock rather than holding one,
// and `idle_in_transaction_session_timeout` reaps a transaction whose client
// vanished (a managed Postgres would otherwise pin its locks until TCP death).
//
// Pools built for one-shot work — migrations, seeds, admin scripts — take no
// tuning at all: a DDL migration building an index on a grown table legitimately
// runs past every ceiling here.

import { readIntEnv } from '@liedmotif/shared';

/** The long-lived pools. Each process owns exactly one. */
export type PoolRole = 'web' | 'worker';

/**
 * A timeout of 0 means "set nothing" — the session then inherits whatever the
 * server or role configures. It is NOT a way to switch a server-side ceiling
 * off: `pg` only sends these as connect-time startup parameters, and it skips
 * any that is zero.
 */
export interface PoolTuning {
  /** Max clients in the pool. */
  max: number;
  /** Per-statement ceiling in ms. */
  statementTimeoutMs: number;
  /** Lock-acquisition ceiling in ms. */
  lockTimeoutMs: number;
  /** Idle-in-transaction ceiling in ms. */
  idleInTransactionTimeoutMs: number;
}

const ROLE_DEFAULTS: Record<PoolRole, PoolTuning> = {
  web: {
    max: 10,
    statementTimeoutMs: 30_000,
    lockTimeoutMs: 10_000,
    idleInTransactionTimeoutMs: 60_000,
  },
  worker: {
    max: 8,
    statementTimeoutMs: 300_000,
    lockTimeoutMs: 30_000,
    idleInTransactionTimeoutMs: 300_000,
  },
};

const ROLE_ENV_PREFIX: Record<PoolRole, string> = { web: 'WEB_DB_', worker: 'WORKER_DB_' };

/**
 * Resolve a role's pool tuning from env, falling back to the shipped defaults.
 *
 * No upper bound on any of these, unlike `TRUSTED_PROXY_HOPS`: there is no size
 * or duration that is definitionally a typo, and an oversized pool fails loudly
 * at Postgres ("too many clients") rather than silently doing the wrong thing.
 */
export function resolvePoolTuning(
  role: PoolRole,
  env: NodeJS.ProcessEnv = process.env,
): PoolTuning {
  const defaults = ROLE_DEFAULTS[role];
  const prefix = ROLE_ENV_PREFIX[role];

  /** A timeout in ms, where 0 is the legal "set nothing" value. */
  function timeout(suffix: string, fallback: number): number {
    return readIntEnv(`${prefix}${suffix}`, { fallback, min: 0 }, env);
  }

  return {
    max: readIntEnv(`${prefix}POOL_MAX`, { fallback: defaults.max, min: 1 }, env),
    statementTimeoutMs: timeout('STATEMENT_TIMEOUT_MS', defaults.statementTimeoutMs),
    lockTimeoutMs: timeout('LOCK_TIMEOUT_MS', defaults.lockTimeoutMs),
    idleInTransactionTimeoutMs: timeout('IDLE_TX_TIMEOUT_MS', defaults.idleInTransactionTimeoutMs),
  };
}
