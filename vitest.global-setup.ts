import pg from 'pg';
import type { TestProject } from 'vitest/node';

// Every `vitest` run on a machine shares one test Postgres (TEST_DATABASE_URL), and
// the integration suites TRUNCATE tables and DROP schemas in their setup. Two runs
// at once wipe each other's rows mid-test: deadlocks, foreign-key errors and hangs
// in hundreds of files. So a run holds a session-level advisory lock for its whole
// length, and a second run waits for the first. The lock lives on this connection,
// so a killed run releases it with its connection.
//
// It polls `pg_try_advisory_lock` instead of blocking in `pg_advisory_lock`: a
// blocked request shows in pg_locks as an ungranted advisory lock, which
// a test that reads pg_locks takes for its own route waiting.
//
// Watch mode (`npm run test:watch`) skips the lock: its teardown runs only when the
// watcher closes, so an idle watcher would block every other run indefinitely.
const LOCK_KEY = 0x7066_7465; // "pfte": unique to the test runner
const POLL_MS = 2_000;

export default async function setup(
  project: TestProject,
): Promise<(() => Promise<void>) | undefined> {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString || project.config.watch) return undefined;

  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 3_000 });
  try {
    await client.connect();
  } catch {
    // No database up: the database-gated files skip themselves, so nothing to guard.
    return undefined;
  }

  let warned = false;
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock($1) as locked',
      [LOCK_KEY],
    );
    if (rows[0]?.locked) break;
    if (!warned) {
      console.warn('Another test run is using the test database. Waiting for it to finish…');
      warned = true;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  return async () => {
    await client.end();
  };
}
