// The built-in placeholder Session Cover: the branded art a fresh session shows
// while its generated cover is still being bought (and keeps when no generated
// cover ever arrives). Seeded as a `cover_images` row + ingested bytes, so it is
// served through the same `/api/covers/<id>` route (never a static
// path).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { coverImages } from '../schema';
import { seedDatabase } from '../seed';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import {
  PLACEHOLDER_COVER_ID,
  PLACEHOLDER_COVER_LABEL,
  PLACEHOLDER_COVER_STORAGE_KEY,
} from './placeholder';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describe('placeholder cover identity', () => {
  it('matches the row migration 0054 inserts', () => {
    // The id, key, and label are a LITERAL here and in SQL; an install that
    // migrated before ever seeding must land on exactly the same row, or every
    // repointed `activity_sessions.cover_image_id` dangles.
    const sql = readFileSync(
      fileURLToPath(new URL('../../drizzle/0054_retire_stock_covers.sql', import.meta.url)),
      'utf8',
    );
    expect(sql).toContain(PLACEHOLDER_COVER_ID);
    expect(sql).toContain(PLACEHOLDER_COVER_STORAGE_KEY);
    expect(sql).toContain(`"label":"${PLACEHOLDER_COVER_LABEL}"`);
  });
});

describeIfDb('placeholder cover seeding', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-placeholder-cover-test');
  }, 60_000);

  afterAll(async () => {
    await ctx?.pool.end();
  });

  beforeEach(async () => {
    await truncateTables(ctx.pool, ['cover_images', 'app_settings']);
  });

  it('seedDatabase seeds the placeholder cover row under its stable id', async () => {
    await seedDatabase(ctx.db);

    const rows = await ctx.db.select().from(coverImages);
    const placeholder = rows.find((row) => row.id === PLACEHOLDER_COVER_ID);
    expect(placeholder).toBeDefined();
    expect(placeholder?.sourceType).toBe('placeholder');
    expect(placeholder?.storageKey).toBe(PLACEHOLDER_COVER_STORAGE_KEY);
    expect((placeholder?.tags as { label?: string })?.label).toBe(PLACEHOLDER_COVER_LABEL);
    // Served via app route from storage — no public static path.
    expect(placeholder?.publicPath).toBeNull();
  });

  it('re-seeding is idempotent for the placeholder row', async () => {
    await seedDatabase(ctx.db);
    await seedDatabase(ctx.db);

    const rows = await ctx.db
      .select()
      .from(coverImages)
      .then((all) => all.filter((row) => row.id === PLACEHOLDER_COVER_ID));
    expect(rows).toHaveLength(1);
  });
});
