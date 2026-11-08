// Database seeding — default settings + the built-in placeholder cover.
//
// `seedDatabase` is the library entry the setup wizard (and the
// `db:seed` script) call. It is idempotent: every write is `onConflictDoNothing`
// keyed on a stable identity, so re-running never duplicates rows and never
// clobbers admin-tuned values. Exposed at the `@liedmotif/db/seed` subpath so the
// web/worker runtime bundles aren't forced to pull the pool factory.

import { pathToFileURL } from 'node:url';
import type { Database } from './client';
import { assertNotTestDatabase, createDb, createPool } from './index';
import { APP_SETTINGS_KEYS, appSettings, defaultUsageLimits } from './schema';
import { ingestPlaceholderCover, type CoverStorageSink, type IngestOutcome } from './covers/ingest';
import { seedPlaceholderCover } from './covers/placeholder';

// Re-export the cover bootstrap surface from the `@liedmotif/db/seed` subpath so
// callers provision rows + bytes through one entrypoint without reaching into
// `./covers/*` directly.
export { ingestPlaceholderCover, type CoverStorageSink, type IngestOutcome } from './covers/ingest';
export {
  PLACEHOLDER_COVER_ID,
  PLACEHOLDER_COVER_STORAGE_KEY,
  seedPlaceholderCover,
} from './covers/placeholder';

export interface SeedOptions {
  /** Timezone for the seeded usage-limit reset window. Defaults to `INSTANCE_TIMEZONE`/`UTC`. */
  resetTimezone?: string;
}

/** Seed the global usage limits into `app_settings` (idempotent). */
export async function seedAppSettings(db: Database, options: SeedOptions = {}): Promise<void> {
  await db
    .insert(appSettings)
    .values({
      key: APP_SETTINGS_KEYS.usageLimits,
      // The Admin pays the providers directly, so their own Track and Cover
      // ceilings are opt-in on a new install (onboarding offers both).
      value: {
        ...defaultUsageLimits(options.resetTimezone),
        trackCeilingEnabled: false,
        coverCeilingEnabled: false,
      },
    })
    .onConflictDoNothing({ target: appSettings.key });
}

/** Run all seeders. Safe to call repeatedly (e.g. on every setup/boot). */
export async function seedDatabase(db: Database, options: SeedOptions = {}): Promise<void> {
  await seedAppSettings(db, options);
  await seedPlaceholderCover(db);
}

/**
 * Ensure both the ROW (DB) and BYTES (storage) of the built-in placeholder cover
 * exist. Idempotent: the seed conflicts on id and ingestion skips objects already
 * present. Callers pass their own storage provider (web/worker already build one)
 * so `@liedmotif/db` stays free of a storage dependency outside the CLI below.
 */
export async function ensurePlaceholderCover(
  db: Database,
  sink: CoverStorageSink,
): Promise<IngestOutcome> {
  await seedPlaceholderCover(db);
  return ingestPlaceholderCover(sink);
}

/** CLI entry: `npm run db:seed`. Owns its own pool; never logs the connection string. */
async function runSeedCli(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('seed: DATABASE_URL is required');
    process.exitCode = 1;
    return;
  }
  assertNotTestDatabase(databaseUrl);
  const pool = createPool(databaseUrl, { applicationName: 'liedmotif-seed', max: 2 });
  try {
    const db = createDb(pool);
    await seedDatabase(db);
    // Also place the bundled cover bytes into the configured storage backend so
    // the cover is servable. `@liedmotif/storage` is imported lazily here so the
    // seed module's static graph stays free of it for runtime consumers.
    const { buildStorageProvider, resolveStorageRuntimeConfig } =
      await import('@liedmotif/storage');
    const storage = buildStorageProvider(resolveStorageRuntimeConfig());
    const outcome = await ingestPlaceholderCover(storage);
    const bytes = outcome === 'written' ? 'ingested' : 'already present';
    console.log(`seed: ensured app settings + placeholder cover (bytes ${bytes})`);
  } finally {
    await pool.end();
  }
}

// Run only when executed directly (not when imported). Avoids side effects on
// import and keeps the module free of top-level await.
const entryArg = process.argv[1];
const invokedDirectly = entryArg !== undefined && import.meta.url === pathToFileURL(entryArg).href;
if (invokedDirectly) {
  void runSeedCli();
}
