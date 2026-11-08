// One-shot full-stack database migration for the Docker deployment (the compose
// `migrate` service). Applies the same ordered
// steps a host dev runs manually — the committed Drizzle app migrations
// (`npm run db:migrate`), then the graphile_worker schema
// (`npm run db:migrate:worker`) — and exits, so web/worker gate their start on
// `service_completed_successfully`. Idempotent: both runners no-op when the
// schema is already current.
//
// Bundled to `dist/migrate-stack.js`. The runtime image copies the committed
// SQL to `/app/drizzle`, which is exactly where the bundled `MIGRATIONS_DIR`
// (`../drizzle` relative to `dist/`) resolves.

import { runMigrations } from 'graphile-worker';
import { assertNotTestDatabase, createDb, createPool } from '@liedmotif/db';
import { runDrizzleMigrations } from '@liedmotif/db/migrate';
import { createLogger, requireEnv } from '@liedmotif/shared';

const log = createLogger({ name: 'migrate-stack' });

async function main(): Promise<void> {
  // `requireEnv` throws a clear error if unset; the connection string itself is
  // never logged (it carries inline credentials).
  const connectionString = requireEnv('DATABASE_URL');
  assertNotTestDatabase(connectionString);

  const pool = createPool(connectionString, { applicationName: 'liedmotif-migrate', max: 1 });
  try {
    log.info('applying app schema migrations (drizzle)');
    await runDrizzleMigrations(createDb(pool));
  } finally {
    await pool.end();
  }

  log.info('installing/updating graphile_worker schema');
  await runMigrations({ connectionString });
  log.info('database schema is up to date');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log.error('stack migration failed', { err });
    process.exit(1);
  });
