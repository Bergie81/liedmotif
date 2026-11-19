// Admin write path for Member budgets: round-trips,
// validation, and the over-subscription warning that saves anyway.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MEMBER_LIMITS,
  DEFAULT_MEMBERS_POOL,
  USAGE_LIMIT_CEILINGS,
} from '@liedmotif/shared';
import { user, userProfiles } from '@liedmotif/db';
import {
  connectTestDb,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

const holder = vi.hoisted(() => ({ db: null as unknown, admin: true }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.admin ? { user: { id: 'admin-1' } } : null),
  getAppSession: async () => ({ user: { id: 'member-1' } }),
}));

const pool = await import('@/app/api/settings/members/pool/route');
const limits = await import('@/app/api/settings/members/[userId]/limits/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function postPool(body: unknown) {
  return pool.POST(
    new Request('http://localhost/api/settings/members/pool', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
}

function postLimits(userId: string, body: unknown) {
  return limits.POST(
    new Request(`http://localhost/api/settings/members/${userId}/limits`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ userId }) },
  );
}

/**
 * Both pooled connections must already be established, otherwise the second
 * save waits out a connection handshake and the two never overlap.
 */
async function warmTwoConnections(): Promise<void> {
  await Promise.all([testDb.pool.query('SELECT 1'), testDb.pool.query('SELECT 1')]);
}

async function createMember(id: string): Promise<string> {
  await testDb.db.insert(user).values({ id, name: id, email: `${id}@example.test` });
  await testDb.db.insert(userProfiles).values({ userId: id, role: 'member' });
  return id;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('member-budget-routes-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, ['user', 'user_settings', 'app_settings']);
  holder.admin = true;
});

describe.skipIf(skip)('member budget routes', () => {
  it('round-trips a member budget through the admin write route', async () => {
    const memberId = await createMember('member-1');
    const res = await postLimits(memberId, { dailyGenerationTasks: 5 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.limits).toEqual({ ...DEFAULT_MEMBER_LIMITS, dailyGenerationTasks: 5 });

    const read = await limits.GET(new Request('http://localhost'), {
      params: Promise.resolve({ userId: memberId }),
    });
    expect((await read.json()).data.limits).toEqual({
      ...DEFAULT_MEMBER_LIMITS,
      dailyGenerationTasks: 5,
    });
  });

  it('rejects negatives, monthly below daily, and anything above the ceiling', async () => {
    const memberId = await createMember('member-1');
    expect((await postLimits(memberId, { dailyGenerationTasks: -1 })).status).toBe(400);
    // Merged with the stored object, monthly 3 would undercut daily 10.
    expect((await postLimits(memberId, { monthlyGenerationTasks: 3 })).status).toBe(400);
    expect((await postPool({ generatedCoversPerMonth: 1 })).status).toBe(400);
    // Without a ceiling an admin typo sets a budget to any integer.
    const overCeiling = USAGE_LIMIT_CEILINGS.dailyGenerationTasks + 1;
    expect((await postLimits(memberId, { dailyGenerationTasks: overCeiling })).status).toBe(400);
    expect((await postPool({ dailyGenerationTasks: overCeiling })).status).toBe(400);
  });

  it('refuses budget writes for the admin or an unknown user', async () => {
    await testDb.db.insert(user).values({ id: 'admin-1', name: 'a', email: 'admin@example.test' });
    await testDb.db.insert(userProfiles).values({ userId: 'admin-1', role: 'admin' });
    expect((await postLimits('admin-1', { dailyGenerationTasks: 5 })).status).toBe(404);
    expect((await postLimits('nobody', { dailyGenerationTasks: 5 })).status).toBe(404);
  });

  it('is admin-only', async () => {
    holder.admin = false;
    expect((await postPool({ dailyGenerationTasks: 10 })).status).toBe(401);
    expect((await postLimits('member-1', {})).status).toBe(401);
  });

  it('saves an over-subscribed budget and reports the warning', async () => {
    const memberId = await createMember('member-1');
    // One member at 100 tasks/day against the default pool of 25.
    const res = await postLimits(memberId, {
      dailyGenerationTasks: 100,
      monthlyGenerationTasks: 500,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.limits.dailyGenerationTasks).toBe(100);
    expect(body.data.overSubscription).toEqual([
      { field: 'dailyGenerationTasks', membersTotal: 100, poolCap: 25 },
      { field: 'monthlyGenerationTasks', membersTotal: 500, poolCap: 125 },
    ]);
  });

  it('round-trips the pool and reports over-subscription after shrinking it', async () => {
    await createMember('member-1');
    const res = await postPool({ dailyGenerationTasks: 4, monthlyGenerationTasks: 40 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.pool).toEqual({
      ...DEFAULT_MEMBERS_POOL,
      dailyGenerationTasks: 4,
      monthlyGenerationTasks: 40,
    });
    expect(body.data.overSubscription).toEqual([
      { field: 'dailyGenerationTasks', membersTotal: 10, poolCap: 4 },
      { field: 'monthlyGenerationTasks', membersTotal: 50, poolCap: 40 },
    ]);
  });

  // Both routes read the stored budget to check the cross-field rule against
  // it. Persisting that merged read instead of the patch restates every field
  // and drops whatever the other tab saved between the read and the write.
  it('keeps both patches when two admin tabs save different pool fields at once', async () => {
    await warmTwoConnections();

    await Promise.all([
      postPool({ dailyGenerationTasks: 7 }),
      postPool({ monthlyGenerationTasks: 70 }),
    ]);

    const body = await (await postPool({})).json();
    expect(body.data.pool).toMatchObject({ dailyGenerationTasks: 7, monthlyGenerationTasks: 70 });
  });

  // The Grant anchors a One-time count: it moves only when
  // the kind does, so a top-up never resets what a Member already spent.
  it('stamps a Grant when the kind switches and keeps it when a total is edited', async () => {
    const memberId = await createMember('member-1');
    const before = Date.now();
    const switched = await (await postLimits(memberId, { kind: 'oneTime' })).json();
    expect(switched.data.limits.kind).toBe('oneTime');
    const grantedAt = switched.data.limits.grantedAt as string;
    expect(new Date(grantedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);

    const topped = await (await postLimits(memberId, { totalGenerationTasks: 40 })).json();
    expect(topped.data.limits).toMatchObject({
      kind: 'oneTime',
      totalGenerationTasks: 40,
      grantedAt,
    });

    // Restating the same kind is not a switch either.
    const restated = await (
      await postLimits(memberId, { kind: 'oneTime', totalGeneratedCovers: 2 })
    ).json();
    expect(restated.data.limits.grantedAt).toBe(grantedAt);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const back = await (await postLimits(memberId, { kind: 'rolling' })).json();
    expect(back.data.limits.kind).toBe('rolling');
    expect(back.data.limits.grantedAt).not.toBe(grantedAt);
  });

  it("refuses a payload carrying the other kind's fields", async () => {
    const memberId = await createMember('member-1');
    // Switching to One-time while sending a day cap; a One-time Member sent a
    // window; a Rolling Member sent a total.
    expect((await postLimits(memberId, { kind: 'oneTime', dailyGenerationTasks: 5 })).status).toBe(
      400,
    );
    expect((await postLimits(memberId, { totalGenerationTasks: 5 })).status).toBe(400);
    expect((await postLimits(memberId, { kind: 'oneTime' })).status).toBe(200);
    expect((await postLimits(memberId, { generatedCoversPerMonth: 5 })).status).toBe(400);
    expect((await postLimits(memberId, { totalGenerationTasks: 5 })).status).toBe(200);
  });

  it('a One-time Member is left out of the over-subscription warning', async () => {
    const memberId = await createMember('member-1');
    const rollingRes = await postLimits(memberId, {
      dailyGenerationTasks: 100,
      monthlyGenerationTasks: 500,
    });
    expect((await rollingRes.json()).data.overSubscription).toHaveLength(2);
    const oneTimeRes = await postLimits(memberId, { kind: 'oneTime' });
    expect((await oneTimeRes.json()).data.overSubscription).toEqual([]);
  });

  it('keeps both patches when two admin tabs save different member budget fields', async () => {
    const memberId = await createMember('member-1');
    await warmTwoConnections();

    await Promise.all([
      postLimits(memberId, { dailyGenerationTasks: 7 }),
      postLimits(memberId, { monthlyGenerationTasks: 70 }),
    ]);

    const body = await (await postLimits(memberId, {})).json();
    expect(body.data.limits).toMatchObject({
      dailyGenerationTasks: 7,
      monthlyGenerationTasks: 70,
    });
  });
});
