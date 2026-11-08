// Shared helpers for the package's integration tests (those that need a real
// Postgres via TEST_DATABASE_URL). Not a test file itself (no `.test.ts` suffix)
// and never imported by the runtime bundle — only by sibling `*.test.ts` files.
//
// The destructive migrate-from-clean suite keeps its own
// inline safety gate; these helpers give the *non-destructive* integration suites
// a shared connection + a scoped `TRUNCATE` so they can start from a clean slate
// without dropping schemas.

import { createDb, createPool, type Database, type Pool } from './index';
import { databaseNameOf, isTestDatabaseUrl } from './database-url';
import { runDrizzleMigrations } from './migrate';

/** The configured test database URL (integration suites skip when unset). */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/**
 * Refuse to run table-truncating tests against anything that doesn't look like a
 * throwaway test database. Mirrors the migrate-from-clean suite's gate: the var must be set,
 * differ from the runtime `DATABASE_URL`, and name a database containing "test".
 * The app runtime enforces the inverse (`assertNotTestDatabase`), so the two can
 * never share a database even when env visibility differs between processes.
 */
export function assertSafeTestDatabase(url: string | undefined): asserts url is string {
  if (!url) {
    throw new Error('TEST_DATABASE_URL must be set to run integration tests');
  }
  if (process.env.DATABASE_URL && url === process.env.DATABASE_URL) {
    throw new Error(
      'Refusing to run integration tests: TEST_DATABASE_URL must not equal DATABASE_URL',
    );
  }
  if (!isTestDatabaseUrl(url)) {
    throw new Error(
      `Refusing to run integration tests: target database "${databaseNameOf(url) ?? '(unparseable)'}" ` +
        'does not look like a test database (its name must contain "test")',
    );
  }
}

export interface TestDb {
  pool: Pool;
  db: Database;
}

/**
 * Open a pooled, schema-typed client against the test database and ensure the
 * committed migrations are applied (idempotent — a no-op when already migrated).
 */
export async function connectTestDb(applicationName: string): Promise<TestDb> {
  assertSafeTestDatabase(TEST_DATABASE_URL);
  const pool = createPool(TEST_DATABASE_URL, { applicationName, max: 2 });
  const db = createDb(pool);
  await runDrizzleMigrations(db);
  return { pool, db };
}

/** Truncate the named tables (and dependents) so a suite starts from a clean slate. */
export async function truncateTables(pool: Pool, tables: readonly string[]): Promise<void> {
  if (tables.length === 0) return;
  const quoted = tables.map((table) => `"${table.replace(/"/g, '""')}"`).join(', ');
  await pool.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
}
