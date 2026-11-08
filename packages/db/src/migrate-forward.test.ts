import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, createPool, type Database, type Pool } from './index';
import { MIGRATIONS_DIR, runDrizzleMigrations } from './migrate';
import { assertSafeTestDatabase } from './test-support';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;
const BASELINE_LAST_TAG = '0047_playlist_covers';
const RECORDED_0048_HASH = '7301e75ede3556853fc2c01dc21c65f0362074971aac84a0f482b66727767580';
const RECORDED_0048_CREATED_AT = 1784894136316;
const RECORDED_0049_HASH = '126105d4686e6219d09a6eaa8496cb73301ba669ced3541ac0318ae0bc467b1f';
const RECORDED_0049_CREATED_AT = 1784898061018;

interface JournalEntry {
  tag: string;
}

async function migrationTags(): Promise<string[]> {
  const journal = JSON.parse(
    await readFile(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  return journal.entries.map((entry) => entry.tag);
}

async function applyMigration(pool: Pool, tag: string): Promise<void> {
  const sqlText = await readFile(path.join(MIGRATIONS_DIR, `${tag}.sql`), 'utf8');
  for (const statement of sqlText.split('--> statement-breakpoint')) {
    const sql = statement.trim();
    if (sql) await pool.query(sql);
  }
}

describeIfDb('forward migration from recorded 0048', () => {
  let pool: Pool;
  let db: Database;

  async function restoreRecorded0048(): Promise<void> {
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await pool.query('CREATE SCHEMA public');

    const tags = await migrationTags();
    const baselineEnd = tags.indexOf(BASELINE_LAST_TAG);
    expect(baselineEnd).toBeGreaterThan(-1);
    for (const tag of tags.slice(0, baselineEnd + 1)) {
      await applyMigration(pool, tag);
    }

    await pool.query(
      'ALTER TABLE "playlists" ADD COLUMN "last_played_at" timestamp with time zone',
    );
    await pool.query('CREATE SCHEMA drizzle');
    await pool.query(`
      CREATE TABLE drizzle.__drizzle_migrations (
        id serial PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);
    await pool.query(
      `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
      [RECORDED_0048_HASH, RECORDED_0048_CREATED_AT],
    );
  }

  beforeAll(async () => {
    assertSafeTestDatabase(testDatabaseUrl);
    pool = createPool(testDatabaseUrl, {
      applicationName: 'liedmotif-migrate-forward-test',
      max: 2,
    });
    db = createDb(pool);
  }, 60_000);

  beforeEach(restoreRecorded0048, 60_000);

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await pool.query('CREATE SCHEMA public');
    await runDrizzleMigrations(db);
    await pool.end();
  });

  it('adds playlist visibility for databases that already recorded 0048', async () => {
    await runDrizzleMigrations(db);
    const { rows } = await pool.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'playlists'
          AND column_name = 'listed_in_playlists'
      ) AS exists
    `);
    expect(rows[0]?.exists).toBe(true);
  });

  it('finishes when playlist visibility exists outside the migration journal', async () => {
    await pool.query(
      'ALTER TABLE "playlists" ADD COLUMN "listed_in_playlists" boolean DEFAULT true NOT NULL',
    );

    await expect(runDrizzleMigrations(db)).resolves.toBeUndefined();
  });

  it('corrects branding provenance on existing generated Playlist covers', async () => {
    await applyMigration(pool, '0049_robust_jack_murdock');
    await pool.query(`UPDATE drizzle.__drizzle_migrations SET hash = $1, created_at = $2`, [
      RECORDED_0049_HASH,
      RECORDED_0049_CREATED_AT,
    ]);
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO cover_images
         (source_type, storage_provider, storage_key, provenance)
       VALUES
         ('generated', 'local-fs', 'covers/generated-playlists/existing.webp',
          '{"playlistId":"00000000-0000-4000-8000-000000000001","branded":true}'::jsonb)
       RETURNING id`,
    );

    await runDrizzleMigrations(db);

    const corrected = await pool.query<{ branded: boolean }>(
      `SELECT (provenance -> 'branded')::boolean AS branded
       FROM cover_images
       WHERE id = $1`,
      [inserted.rows[0]!.id],
    );
    expect(corrected.rows[0]?.branded).toBe(false);
  });
});
