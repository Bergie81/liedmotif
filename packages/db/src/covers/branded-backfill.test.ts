import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../testing';
import { coverImages } from '../schema';
import { PLACEHOLDER_COVER_ID, seedPlaceholderCover } from './placeholder';

// Migration 0073 marks which stored covers already carry the badge. It runs
// ONCE against a real instance's history, and a wrong answer either doubles the
// badge on legacy exports or strips it from new ones — so the shipped SQL
// itself is what runs here. Its ALTER is IF NOT EXISTS exactly so the file can
// re-run against the already-migrated test database.
const MIGRATION_SQL = readFileSync(
  new URL('../../drizzle/0073_cover_branded_backfill.sql', import.meta.url),
  'utf8',
);

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('cover branded backfill (migration 0073)', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-branded-backfill-test');
  }, 60_000);

  afterAll(async () => {
    await ctx?.pool.end();
  });

  beforeEach(async () => {
    await truncateTables(ctx.pool, ['cover_images']);
  });

  async function seedCover(
    id: string,
    values: Partial<typeof coverImages.$inferInsert>,
  ): Promise<string> {
    await ctx.db.insert(coverImages).values({
      id,
      sourceType: 'generated',
      storageProvider: 'local-fs',
      storageKey: `covers/${id}.webp`,
      ...values,
    });
    return id;
  }

  async function brandedOf(id: string): Promise<boolean | null> {
    const [row] = await ctx.db
      .select({ branded: coverImages.branded })
      .from(coverImages)
      .where(eq(coverImages.id, id));
    return row?.branded ?? null;
  }

  it('marks the legacy row shapes whose stored bytes carry the badge', async () => {
    const badgedGenerated = await seedCover('11111111-1111-4111-8111-111111111111', {
      provenance: { ownerUserId: 'owner', activitySessionId: 'session', branded: true },
    });
    // Generated before badge compositing existed: its bytes really are clean.
    const preBadgeGenerated = await seedCover('22222222-2222-4222-8222-222222222222', {
      provenance: { ownerUserId: 'owner', activitySessionId: 'session' },
    });
    // A session upload was badged at store time; a playlist upload never was.
    const sessionUpload = await seedCover('33333333-3333-4333-8333-333333333333', {
      sourceType: 'uploaded',
      provenance: { ownerUserId: 'owner', activitySessionId: 'session' },
    });
    const playlistUpload = await seedCover('44444444-4444-4444-8444-444444444444', {
      sourceType: 'uploaded',
      provenance: { ownerUserId: 'owner', playlistId: 'playlist' },
    });
    await seedCover(PLACEHOLDER_COVER_ID, { sourceType: 'placeholder', storageProvider: 'local' });

    await ctx.pool.query(MIGRATION_SQL);

    expect(await brandedOf(badgedGenerated)).toBe(true);
    expect(await brandedOf(preBadgeGenerated)).toBe(false);
    expect(await brandedOf(sessionUpload)).toBe(true);
    expect(await brandedOf(playlistUpload)).toBe(false);
    expect(await brandedOf(PLACEHOLDER_COVER_ID)).toBe(true);
  });

  it('seeds a fresh placeholder as branded, matching the migration', async () => {
    await seedPlaceholderCover(ctx.db);
    expect(await brandedOf(PLACEHOLDER_COVER_ID)).toBe(true);
  });
});
