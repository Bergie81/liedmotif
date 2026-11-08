import { describe, expect, it } from 'vitest';
import { resolvePoolTuning } from './pool-tuning';

// Pool sizing and session timeouts per process role. The numbers are a safety
// boundary — a runaway query must not be able to hold a connection forever —
// so the failure mode that matters is a value silently reading as something
// other than what the operator configured.

describe('resolvePoolTuning', () => {
  it('keeps the shipped pool sizes when nothing is configured', () => {
    expect(resolvePoolTuning('web', {}).max).toBe(10);
    expect(resolvePoolTuning('worker', {}).max).toBe(8);
  });

  it("leaves the worker's long jobs room to finish, and bounds the web tighter", () => {
    // Downloads are bounded at 120s and analysis runs longer still, so a
    // request-sized ceiling on the worker would abort work already paid for.
    const worker = resolvePoolTuning('worker', {});
    const web = resolvePoolTuning('web', {});
    expect(worker.statementTimeoutMs).toBeGreaterThanOrEqual(150_000);
    expect(worker.idleInTransactionTimeoutMs).toBeGreaterThanOrEqual(150_000);
    expect(web.statementTimeoutMs).toBeLessThan(worker.statementTimeoutMs);
    expect(web.idleInTransactionTimeoutMs).toBeLessThan(worker.idleInTransactionTimeoutMs);
  });

  it('honors per-role overrides', () => {
    const web = resolvePoolTuning('web', {
      WEB_DB_POOL_MAX: '25',
      WEB_DB_STATEMENT_TIMEOUT_MS: '5000',
      WEB_DB_LOCK_TIMEOUT_MS: '2000',
      WEB_DB_IDLE_TX_TIMEOUT_MS: '7000',
      WORKER_DB_POOL_MAX: '99',
    });
    expect(web).toEqual({
      max: 25,
      statementTimeoutMs: 5_000,
      lockTimeoutMs: 2_000,
      idleInTransactionTimeoutMs: 7_000,
    });
  });

  it('treats a blank value as unset', () => {
    expect(resolvePoolTuning('worker', { WORKER_DB_POOL_MAX: '  ' }).max).toBe(8);
  });

  it('refuses a malformed value instead of falling back to the default', () => {
    expect(() => resolvePoolTuning('web', { WEB_DB_POOL_MAX: 'ten' })).toThrow(/WEB_DB_POOL_MAX/);
    expect(() => resolvePoolTuning('web', { WEB_DB_POOL_MAX: '0' })).toThrow(/WEB_DB_POOL_MAX/);
    expect(() => resolvePoolTuning('worker', { WORKER_DB_STATEMENT_TIMEOUT_MS: '-1' })).toThrow(
      /WORKER_DB_STATEMENT_TIMEOUT_MS/,
    );
  });
});
