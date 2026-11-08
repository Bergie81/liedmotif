import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  connectTestDb,
  createUser,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';
import {
  APP_SETTINGS_KEYS,
  USER_SETTINGS_KEYS,
  appSettings,
  invites,
  userSettings,
} from '../schema';

// Migration 0092 lifts a stored concurrency of 0 to 1, the contracts' floor, in
// every place a budget lives. A Member budget or the Pool is validated as
// `stored || patch`, so a surviving 0 would fail every later edit of it, and a
// pending invite's budget reaches the Member's limits unvalidated at claim.
// The shipped SQL itself runs here.
const MIGRATION_SQL = readFileSync(
  new URL('../../drizzle/0092_concurrency_at_least_one.sql', import.meta.url),
  'utf8',
);

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('concurrency floor backfill (migration 0092)', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-concurrency-floor-test');
  }, 60_000);

  afterAll(async () => {
    await ctx?.pool.end();
  });

  beforeEach(async () => {
    await truncateTables(ctx.pool, ['app_settings', 'user_settings', 'invites']);
  });

  async function appSetting(key: string) {
    const [row] = await ctx.db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, key));
    return row?.value;
  }

  async function inviteBudget(id: string) {
    const [row] = await ctx.db
      .select({ budget: invites.budget })
      .from(invites)
      .where(eq(invites.id, id));
    return row?.budget as Record<string, unknown> | null | undefined;
  }

  it('lifts a stored 0 to 1 on the instance limits, Member budgets, the Pool and pending invites', async () => {
    const admin = await createUser(ctx.db);
    const zeroed = await createUser(ctx.db);
    const wide = await createUser(ctx.db);
    await ctx.db.insert(appSettings).values([
      {
        key: APP_SETTINGS_KEYS.usageLimits,
        value: { maxConcurrentJobs: 0, dailyGenerationTasks: 0 },
      },
      { key: APP_SETTINGS_KEYS.memberPool, value: { maxConcurrentJobs: 0 } },
    ]);
    await ctx.db.insert(userSettings).values([
      {
        ownerUserId: zeroed,
        key: USER_SETTINGS_KEYS.limits,
        value: { maxConcurrentJobs: 0, dailyGenerationTasks: 0 },
      },
      { ownerUserId: wide, key: USER_SETTINGS_KEYS.limits, value: { maxConcurrentJobs: 3 } },
      { ownerUserId: wide, key: 'generation', value: { maxConcurrentJobs: 0 } },
    ]);
    const invite = (consumedAt: Date | null) => ({
      kind: 'member_invite' as const,
      label: 'Lisa',
      tokenHash: `hash-${String(consumedAt)}`,
      budget: { maxConcurrentJobs: 0 } as never,
      createdByUserId: admin,
      expiresAt: new Date(Date.now() + 86_400_000),
      consumedAt,
    });
    const [pending, consumed] = await ctx.db
      .insert(invites)
      .values([invite(null), invite(new Date())])
      .returning({ id: invites.id });

    await ctx.pool.query(MIGRATION_SQL);

    expect(await appSetting(APP_SETTINGS_KEYS.usageLimits)).toEqual({
      maxConcurrentJobs: 1,
      dailyGenerationTasks: 0,
    });
    expect(await appSetting(APP_SETTINGS_KEYS.memberPool)).toEqual({ maxConcurrentJobs: 1 });
    const limits = await ctx.db
      .select({
        ownerUserId: userSettings.ownerUserId,
        key: userSettings.key,
        value: userSettings.value,
      })
      .from(userSettings);
    expect(limits).toEqual(
      expect.arrayContaining([
        {
          ownerUserId: zeroed,
          key: USER_SETTINGS_KEYS.limits,
          value: { maxConcurrentJobs: 1, dailyGenerationTasks: 0 },
        },
        { ownerUserId: wide, key: USER_SETTINGS_KEYS.limits, value: { maxConcurrentJobs: 3 } },
        { ownerUserId: wide, key: 'generation', value: { maxConcurrentJobs: 0 } },
      ]),
    );
    expect(await inviteBudget(pending!.id)).toEqual({ maxConcurrentJobs: 1 });
    expect(await inviteBudget(consumed!.id)).toEqual({ maxConcurrentJobs: 0 });
  });
});
