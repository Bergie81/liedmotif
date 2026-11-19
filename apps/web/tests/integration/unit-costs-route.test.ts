// Admin write path for Unit costs: round trip,
// validation, and the Member refusal.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_UNIT_COSTS, UNIT_COST_CEILING_USD } from '@liedmotif/shared';
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

const costs = await import('@/app/api/settings/unit-costs/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function post(body: unknown) {
  return costs.POST(
    new Request('http://localhost/api/settings/unit-costs', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
}

function get() {
  return costs.GET(new Request('http://localhost/api/settings/unit-costs'));
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('unit-costs-route-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, ['app_settings']);
  holder.admin = true;
});

describe.skipIf(skip)('unit costs route', () => {
  it('reads the zero defaults before anything is saved', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).data.unitCosts).toEqual(DEFAULT_UNIT_COSTS);
  });

  it('round-trips a partial patch over the stored prices', async () => {
    expect((await post({ perTrackUsd: 0.05 })).status).toBe(200);
    const res = await post({ perCoverUsd: 0.1 });
    expect(res.status).toBe(200);
    expect((await res.json()).data.unitCosts).toEqual({ perTrackUsd: 0.05, perCoverUsd: 0.1 });
    expect((await (await get()).json()).data.unitCosts).toEqual({
      perTrackUsd: 0.05,
      perCoverUsd: 0.1,
    });
  });

  it('rejects negatives, fractional cents, the ceiling overshoot, and unknown keys', async () => {
    expect((await post({ perTrackUsd: -1 })).status).toBe(400);
    expect((await post({ perCoverUsd: 0.005 })).status).toBe(400);
    expect((await post({ perTrackUsd: UNIT_COST_CEILING_USD + 1 })).status).toBe(400);
    expect((await post({ currency: 'EUR' })).status).toBe(400);
    expect((await (await get()).json()).data.unitCosts).toEqual(DEFAULT_UNIT_COSTS);
  });

  it('refuses a Member on both verbs', async () => {
    holder.admin = false;
    expect((await get()).status).toBe(401);
    expect((await post({ perTrackUsd: 0.05 })).status).toBe(401);
  });
});
