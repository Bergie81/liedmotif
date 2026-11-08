// Transaction helpers for common workflows.
//
// `withTransaction` is the plain wrapper. `withRetryableTransaction` adds
// bounded retry on Postgres serialization failures / deadlocks (SQLSTATE 40001 /
// 40P01) — the failure mode the concurrency-sensitive paths (buffer fill,
// idempotent paid-submit guarding) can hit.

import type { Database } from './client';

/**
 * The transaction handle Drizzle passes to a `db.transaction` callback. Derived
 * from `Database` so it always tracks the bound schema without a manual type.
 */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Either the pool-backed database or an open transaction handle — for repo
 * functions that must be composable into a caller's transaction (e.g. reads and
 * writes that run under an advisory lock).
 */
export type DbOrTx = Database | Transaction;

/** Postgres SQLSTATEs that are safe to retry by re-running the whole transaction. */
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

/** Read a SQLSTATE-looking `code` string directly off one error object. */
function directSqlState(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** Hard ceiling on nodes visited while unwrapping, belt-and-suspenders vs cycles. */
const MAX_ERROR_CHAIN_NODES = 64;

/**
 * True when re-running the transaction has a real chance of succeeding.
 *
 * A retryable SQLSTATE (40001 / 40P01) does not always sit on the top-level
 * error: driver and pool layers re-throw with the original attached under
 * `cause` (sometimes nested), and batched paths surface it inside an
 * `AggregateError.errors`. So we walk the whole graph — the `cause` chain plus
 * any `errors` arrays — and return true on the first retryable code found. A
 * `seen` set drops cycles and a visited-node budget bounds the traversal, so it
 * always terminates regardless of how the error was wrapped.
 */
export function isRetryableTransactionError(error: unknown): boolean {
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];
  let budget = MAX_ERROR_CHAIN_NODES;

  while (stack.length > 0 && budget > 0) {
    budget -= 1;
    const current = stack.pop();
    if (typeof current !== 'object' || current === null || seen.has(current)) {
      continue;
    }
    seen.add(current);

    const code = directSqlState(current);
    if (code !== undefined && RETRYABLE_SQLSTATES.has(code)) {
      return true;
    }

    if ('cause' in current) {
      stack.push((current as { cause?: unknown }).cause);
    }
    const nested = (current as { errors?: unknown }).errors;
    if (Array.isArray(nested)) {
      for (const child of nested) {
        stack.push(child);
      }
    }
  }
  return false;
}

/** Run `fn` inside a single transaction. Thin wrapper over `db.transaction`. */
export function withTransaction<T>(db: Database, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}

export interface RetryableTransactionOptions {
  /** Total attempts including the first. Defaults to 3. */
  maxAttempts?: number;
  /** Base backoff in ms; the Nth retry waits `retryDelayMs * attempt`. Defaults to 50. */
  retryDelayMs?: number;
  /** Injectable sleep, primarily for tests. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Coerce a caller-supplied attempt count into a finite, positive integer.
 *
 * Guards the retry loop against pathological inputs: `Infinity` would spin
 * forever and `NaN` would skip the loop entirely and then rethrow `undefined`.
 * Undefined or any non-finite value falls back to the default; fractional values
 * floor; anything below 1 clamps up to a single attempt.
 */
function normalizeMaxAttempts(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_ATTEMPTS;
  }
  const floored = Math.floor(value);
  return floored < 1 ? 1 : floored;
}

/**
 * Run `fn` in a transaction, retrying on serialization/deadlock failures with a
 * small linear backoff. Non-retryable errors propagate immediately; the last
 * attempt's error is rethrown.
 */
export async function withRetryableTransaction<T>(
  db: Database,
  fn: (tx: Transaction) => Promise<T>,
  options: RetryableTransactionOptions = {},
): Promise<T> {
  const maxAttempts = normalizeMaxAttempts(options.maxAttempts);
  const retryDelayMs = options.retryDelayMs ?? 50;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await db.transaction(fn);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableTransactionError(error)) {
        throw error;
      }
      await sleep(retryDelayMs * attempt);
    }
  }
  // Unreachable: the loop either returns or throws. Satisfies the type checker.
  throw lastError;
}
