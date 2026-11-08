import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedPlaceholderCover } from '../seed';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { PLACEHOLDER_COVER_ID, PLACEHOLDER_COVER_STORAGE_KEY } from './placeholder';
import { getCoverImageById } from './repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('cover repo', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-covers-repo-test');
  }, 60_000);

  afterAll(async () => {
    await ctx?.pool.end();
  });

  beforeEach(async () => {
    await truncateTables(ctx.pool, ['cover_images']);
    await seedPlaceholderCover(ctx.db);
  });

  it('fetches a single cover by id, or null when absent', async () => {
    const row = await getCoverImageById(ctx.db, PLACEHOLDER_COVER_ID);
    expect(row?.storageKey).toBe(PLACEHOLDER_COVER_STORAGE_KEY);

    expect(await getCoverImageById(ctx.db, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});
