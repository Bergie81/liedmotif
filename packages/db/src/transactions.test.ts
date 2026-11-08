import { describe, expect, it, vi } from 'vitest';
import { isRetryableTransactionError, withRetryableTransaction, type Database } from './index';

// A serialization failure carries SQLSTATE 40001; a deadlock 40P01.
const serializationFailure = Object.assign(new Error('could not serialize'), { code: '40001' });
const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
const notNullViolation = Object.assign(new Error('null value'), { code: '23502' });
const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });

/** Minimal fake whose `transaction` runs the callback against a stub tx. */
function fakeDb(transaction: Database['transaction']): Database {
  return { transaction } as unknown as Database;
}

describe('isRetryableTransactionError', () => {
  it('flags serialization failures and deadlocks, nothing else', () => {
    expect(isRetryableTransactionError(serializationFailure)).toBe(true);
    expect(isRetryableTransactionError(deadlock)).toBe(true);
    expect(isRetryableTransactionError(notNullViolation)).toBe(false);
    expect(isRetryableTransactionError(new Error('plain'))).toBe(false);
    expect(isRetryableTransactionError(undefined)).toBe(false);
  });

  it('detects a retryable code nested one level deep in `cause`', () => {
    const wrapped = new Error('wrapped by the driver', { cause: serializationFailure });
    expect(isRetryableTransactionError(wrapped)).toBe(true);
  });

  it('detects a retryable code two levels deep in `cause.cause`', () => {
    const inner = new Error('inner', { cause: deadlock });
    const outer = new Error('outer', { cause: inner });
    expect(isRetryableTransactionError(outer)).toBe(true);
  });

  it('detects a retryable code inside an AggregateError.errors array', () => {
    const aggregate = new AggregateError(
      [new Error('benign'), serializationFailure],
      'one or more transactions failed',
    );
    expect(isRetryableTransactionError(aggregate)).toBe(true);
  });

  it('does not retry a non-retryable code, even when wrapped in `cause`', () => {
    const wrapped = new Error('wrapped unique violation', { cause: uniqueViolation });
    expect(isRetryableTransactionError(wrapped)).toBe(false);
  });

  it('terminates on a cyclic cause chain instead of looping forever', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isRetryableTransactionError(a)).toBe(false);
  });
});

describe('withRetryableTransaction', () => {
  it('retries a serialization failure then succeeds', async () => {
    let attempts = 0;
    const transaction = vi.fn(async (fn: (tx: never) => Promise<unknown>) => {
      attempts += 1;
      if (attempts === 1) throw serializationFailure;
      return fn(undefined as never);
    }) as unknown as Database['transaction'];

    const result = await withRetryableTransaction(fakeDb(transaction), async () => 'ok', {
      retryDelayMs: 0,
    });

    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('rethrows a non-retryable error without retrying', async () => {
    let attempts = 0;
    const transaction = (async () => {
      attempts += 1;
      throw notNullViolation;
    }) as unknown as Database['transaction'];

    await expect(
      withRetryableTransaction(fakeDb(transaction), async () => 'never', { retryDelayMs: 0 }),
    ).rejects.toBe(notNullViolation);
    expect(attempts).toBe(1);
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    let attempts = 0;
    const transaction = (async () => {
      attempts += 1;
      throw deadlock;
    }) as unknown as Database['transaction'];

    await expect(
      withRetryableTransaction(fakeDb(transaction), async () => 'never', {
        maxAttempts: 3,
        retryDelayMs: 0,
      }),
    ).rejects.toBe(deadlock);
    expect(attempts).toBe(3);
  });

  // A transaction that always deadlocks: it retries until maxAttempts is hit,
  // so the observed attempt count is exactly the normalized maxAttempts. This
  // lets us assert the coercion of pathological inputs (FIX 3).
  function alwaysDeadlocks(): { db: Database; attempts: () => number } {
    let attempts = 0;
    const transaction = (async () => {
      attempts += 1;
      throw deadlock;
    }) as unknown as Database['transaction'];
    return { db: fakeDb(transaction), attempts: () => attempts };
  }

  it('treats maxAttempts: Infinity as the default (3), not an unbounded loop', async () => {
    const { db, attempts } = alwaysDeadlocks();
    await expect(
      withRetryableTransaction(db, async () => 'never', {
        maxAttempts: Number.POSITIVE_INFINITY,
        retryDelayMs: 0,
      }),
    ).rejects.toBe(deadlock);
    expect(attempts()).toBe(3);
  });

  it('treats maxAttempts: NaN as the default (3) rather than skipping the loop', async () => {
    const { db, attempts } = alwaysDeadlocks();
    await expect(
      withRetryableTransaction(db, async () => 'never', {
        maxAttempts: Number.NaN,
        retryDelayMs: 0,
      }),
    ).rejects.toBe(deadlock);
    expect(attempts()).toBe(3);
  });

  it('clamps maxAttempts: 0 up to a single attempt', async () => {
    const { db, attempts } = alwaysDeadlocks();
    await expect(
      withRetryableTransaction(db, async () => 'never', { maxAttempts: 0, retryDelayMs: 0 }),
    ).rejects.toBe(deadlock);
    expect(attempts()).toBe(1);
  });

  it('floors a fractional maxAttempts (2.5 → 2 attempts)', async () => {
    const { db, attempts } = alwaysDeadlocks();
    await expect(
      withRetryableTransaction(db, async () => 'never', { maxAttempts: 2.5, retryDelayMs: 0 }),
    ).rejects.toBe(deadlock);
    expect(attempts()).toBe(2);
  });

  it('still returns a passing result when maxAttempts is non-finite', async () => {
    let attempts = 0;
    const transaction = vi.fn(async (fn: (tx: never) => Promise<unknown>) => {
      attempts += 1;
      return fn(undefined as never);
    }) as unknown as Database['transaction'];

    const result = await withRetryableTransaction(fakeDb(transaction), async () => 'ok', {
      maxAttempts: Number.POSITIVE_INFINITY,
      retryDelayMs: 0,
    });

    expect(result).toBe('ok');
    expect(attempts).toBe(1);
  });
});
