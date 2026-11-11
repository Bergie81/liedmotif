import { describe, expect, it, vi } from 'vitest';
import { buildPoolConfig, createPool } from './index';
import { assertSafeTestDatabase, TEST_DATABASE_URL } from './test-support';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describe('buildPoolConfig', () => {
  it('throws when the connection string is empty', () => {
    expect(() => buildPoolConfig('')).toThrow(/DATABASE_URL is required/);
  });

  it('applies sensible defaults', () => {
    const config = buildPoolConfig('postgres://u:p@localhost:5432/db');
    expect(config.connectionString).toBe('postgres://u:p@localhost:5432/db');
    expect(config.max).toBe(10);
    expect(config.application_name).toBe('liedmotif');
    expect(config.connectionTimeoutMillis).toBe(10_000);
  });

  it('honors overrides', () => {
    const config = buildPoolConfig('postgres://u:p@localhost:5432/db', {
      max: 4,
      applicationName: 'liedmotif-worker',
      connectionTimeoutMillis: 2_000,
    });
    expect(config.max).toBe(4);
    expect(config.application_name).toBe('liedmotif-worker');
    expect(config.connectionTimeoutMillis).toBe(2_000);
  });

  it('leaves session timeouts off unless asked for', () => {
    // The migration and seed pools take no tuning: a DDL migration building an
    // index on a grown table runs far past any request-sized ceiling.
    const config = buildPoolConfig('postgres://u:p@localhost:5432/db');
    expect(config.statement_timeout).toBeUndefined();
    expect(config.lock_timeout).toBeUndefined();
    expect(config.idle_in_transaction_session_timeout).toBeUndefined();
  });

  it('passes a tuning under the names pg sends at connect, and drops a zero', () => {
    // A zero would be skipped by pg anyway, so keeping it in the config would
    // claim a ceiling the session does not have.
    const config = buildPoolConfig('postgres://u:p@localhost:5432/db', {
      tuning: {
        max: 4,
        statementTimeoutMs: 30_000,
        lockTimeoutMs: 0,
        idleInTransactionTimeoutMs: 60_000,
      },
    });
    expect(config.max).toBe(4);
    expect(config.statement_timeout).toBe(30_000);
    expect(config.lock_timeout).toBeUndefined();
    expect(config.idle_in_transaction_session_timeout).toBe(60_000);
  });
});

describeIfDb('pool session timeouts (against a real Postgres)', () => {
  it('applies them to a fresh connection and cancels an overrunning statement', async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL);
    const pool = createPool(TEST_DATABASE_URL, {
      applicationName: 'liedmotif-pool-timeout-test',
      tuning: {
        max: 1,
        statementTimeoutMs: 750,
        lockTimeoutMs: 500,
        idleInTransactionTimeoutMs: 3_000,
      },
    });
    try {
      const settings = await pool.query<{ name: string; setting: string }>(
        `select name, setting from pg_settings
         where name in ('statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout')`,
      );
      expect(Object.fromEntries(settings.rows.map((row) => [row.name, row.setting]))).toEqual({
        statement_timeout: '750',
        lock_timeout: '500',
        idle_in_transaction_session_timeout: '3000',
      });

      // 57014 = query_canceled: the ceiling is real, not just reported.
      await expect(pool.query('select pg_sleep(3)')).rejects.toMatchObject({ code: '57014' });
    } finally {
      await pool.end();
    }
  }, 20_000);
});

describeIfDb('pool connection loss (against a real Postgres)', () => {
  it('survives losing the backend of a client checked out for a transaction', async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL);
    const pool = createPool(TEST_DATABASE_URL, { max: 1 });
    const admin = createPool(TEST_DATABASE_URL, { max: 1 });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const client = await pool.connect();
    try {
      // pg-pool drops its own idle listener on checkout, so without one of ours
      // the lost connection's 'error' event is uncaught and ends the process.
      expect(client.listenerCount('error')).toBeGreaterThan(0);
      await client.query('begin');
      const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
      const ended = new Promise((resolve) => client.once('end', resolve));
      await admin.query('select pg_terminate_backend($1)', [rows[0]!.pid]);
      await ended;

      await expect(client.query('select 1')).rejects.toThrow();
    } finally {
      client.release();
    }
    try {
      expect((await pool.query<{ ok: number }>('select 1 as ok')).rows[0]!.ok).toBe(1);
    } finally {
      stdout.mockRestore();
      await admin.end();
      await pool.end();
    }
  }, 20_000);
});

describe('createPool', () => {
  it('survives an idle-client error instead of crashing the process', async () => {
    const pool = createPool('postgres://u:p@localhost:5432/db');
    try {
      // An unhandled 'error' event is fatal in Node; emitting one here throws
      // synchronously unless the pool ships with a listener.
      expect(pool.listenerCount('error')).toBeGreaterThan(0);
      expect(() => pool.emit('error', new Error('idle client lost connection'))).not.toThrow();
    } finally {
      await pool.end();
    }
  });

  it('reports an idle-client error through the redacting logger, never as a raw error', async () => {
    const pool = createPool('postgres://u:p@localhost:5432/db');
    const lines: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      pool.emit(
        'error',
        Object.assign(new Error('connection to postgres://u:p@host/db failed'), { code: '57P01' }),
      );

      expect(consoleError).not.toHaveBeenCalled();
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        level: 'error',
        name: 'db',
        errorName: 'Error',
        errorCode: '57P01',
      });
      // A bounded code/name pair only — no message, stack, or connection string.
      expect(lines[0]).not.toContain('postgres://');
      expect(lines[0]).not.toContain('stack');
    } finally {
      stdout.mockRestore();
      consoleError.mockRestore();
      await pool.end();
    }
  });
});
