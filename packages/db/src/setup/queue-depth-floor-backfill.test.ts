import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  connectTestDb,
  createUser,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';
import { APP_SETTINGS_KEYS, USER_SETTINGS_KEYS, appSettings, userSettings } from '../schema';

// Migration 0087 lifts a stored queue depth of 0 to 1, the contract's floor. A
// Member budget is validated as `stored || patch`, so a surviving 0 would make
// every later edit of that Member's budget fail on a field the form never shows.
// The shipped SQL itself runs here.
const MIGRATION_SQL = readFileSync(
  new URL('../../drizzle/0087_queue_depth_at_least_one.sql', import.meta.url),
  'utf8',
);

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('queue depth floor backfill (migration 0087)', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-queue-depth-floor-test');
  }, 60_000);

  afterAll(async () => {
    await ctx?.pool.end();
  });

  beforeEach(async () => {
    await truncateTables(ctx.pool, ['app_settings', 'user_settings']);
  });

  async function memberLimits(ownerUserId: string) {
    const [row] = await ctx.db
      .select({ value: userSettings.value })
      .from(userSettings)
      .where(
        and(
          eq(userSettings.ownerUserId, ownerUserId),
          eq(userSettings.key, USER_SETTINGS_KEYS.limits),
        ),
      );
    return row?.value as Record<string, unknown>;
  }

  it('lifts a stored 0 to 1 on the instance limits and Member budgets, and leaves the rest', async () => {
    const zeroed = await createUser(ctx.db);
    const deep = await createUser(ctx.db);
    await ctx.db.insert(appSettings).values({
      key: APP_SETTINGS_KEYS.usageLimits,
      value: { maxQueuedTracks: 0, dailyGenerationTasks: 0 },
    });
    await ctx.db.insert(userSettings).values([
      {
        ownerUserId: zeroed,
        key: USER_SETTINGS_KEYS.limits,
        value: { maxQueuedTracks: 0, maxConcurrentJobs: 0 },
      },
      { ownerUserId: deep, key: USER_SETTINGS_KEYS.limits, value: { maxQueuedTracks: 4 } },
      { ownerUserId: deep, key: 'generation', value: { maxQueuedTracks: 0 } },
    ]);

    await ctx.pool.query(MIGRATION_SQL);

    const [instance] = await ctx.db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, APP_SETTINGS_KEYS.usageLimits));
    expect(instance?.value).toEqual({ maxQueuedTracks: 1, dailyGenerationTasks: 0 });
    expect(await memberLimits(zeroed)).toEqual({ maxQueuedTracks: 1, maxConcurrentJobs: 0 });
    expect(await memberLimits(deep)).toEqual({ maxQueuedTracks: 4 });
    const [unrelated] = await ctx.db
      .select({ value: userSettings.value })
      .from(userSettings)
      .where(and(eq(userSettings.ownerUserId, deep), eq(userSettings.key, 'generation')));
    expect(unrelated?.value).toEqual({ maxQueuedTracks: 0 });
  });
});
