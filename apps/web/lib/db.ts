// Server-side database access for the web process. The pool and the typed
// Drizzle client are cached on globalThis so Next's dev HMR doesn't open a new
// pool on every reload. The web pool is separate from the worker pool (different
// processes). This module must only be imported from server code (route
// handlers, server components) — never the client.

import {
  assertNotTestDatabase,
  createDb,
  createPool,
  resolvePoolTuning,
  type Database,
  type Pool,
} from '@liedmotif/db';

const globalForDb = globalThis as unknown as {
  __liedmotifWebPool?: Pool;
  __liedmotifWebDb?: Database;
};

export function getPool(): Pool {
  if (!globalForDb.__liedmotifWebPool) {
    const databaseUrl = process.env.DATABASE_URL ?? '';
    // Fail closed: never run the app against a test database — the test suites
    // truncate/drop whatever DATABASE_URL would share with TEST_DATABASE_URL.
    assertNotTestDatabase(databaseUrl);
    globalForDb.__liedmotifWebPool = createPool(databaseUrl, {
      applicationName: 'liedmotif-web',
      tuning: resolvePoolTuning('web'),
    });
  }
  return globalForDb.__liedmotifWebPool;
}

/** Schema-typed Drizzle client for the web process, backed by the cached pool. */
export function getDb(): Database {
  if (!globalForDb.__liedmotifWebDb) {
    globalForDb.__liedmotifWebDb = createDb(getPool());
  }
  return globalForDb.__liedmotifWebDb;
}

/** Close the cached pool on shutdown. A no-op when no request ever opened one,
 *  so draining never creates a pool just to end it. */
export async function closeWebPool(): Promise<void> {
  const pool = globalForDb.__liedmotifWebPool;
  if (!pool) return;
  globalForDb.__liedmotifWebPool = undefined;
  globalForDb.__liedmotifWebDb = undefined;
  await pool.end();
}
