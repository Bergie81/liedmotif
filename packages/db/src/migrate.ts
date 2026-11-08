// Programmatic Drizzle migration runner.
//
// `npm run db:migrate` (the `drizzle-kit migrate` CLI) is the operational path.
// This helper applies the SAME committed SQL files from code — used by the
// migrate-from-clean integration test and available to any bootstrap script. It
// is source-relative (resolved via `import.meta.url`), so it works under `tsx`
// and Vitest where `packages/db/drizzle` sits next to `src`.

import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client';

/** Absolute path to the committed SQL migrations folder (`packages/db/drizzle`). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

/** Apply all pending Drizzle migrations to the database `db` is bound to. */
export async function runDrizzleMigrations(
  db: Database,
  migrationsFolder: string = MIGRATIONS_DIR,
): Promise<void> {
  await migrate(db, { migrationsFolder });
}
