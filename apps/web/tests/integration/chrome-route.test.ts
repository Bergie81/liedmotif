// `GET /api/chrome` — the app shell's per-navigation refetch. Owner-gated, not
// admin-gated: the shell renders for Members too, so their usage chrome must
// refresh here (`/api/diagnostics` is admin-only and refuses them). Returns
// exactly `{ usage, activeSession }`.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateUsageLimits, userProfiles } from '@liedmotif/db';
import {
  connectTestDb,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

const holder = vi.hoisted(() => ({ db: null as unknown, userId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAppSession: async () => (holder.userId ? { user: { id: holder.userId } } : null),
  getAdminSession: async () => null,
}));
vi.mock('@/lib/providers', () => ({ getTypicalTracksPerMusicRequest: () => 2 }));

const { GET: chromeGet } = await import('@/app/api/chrome/route');

/** A same-origin API call: the guards look only at the absent `Origin`. */
const apiRequest = () => new Request('http://localhost/api');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('chrome-route-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, [
    ...GENERATION_FIXTURE_TABLES,
    'user_settings',
    'app_settings',
  ]);
  holder.userId = null;
  await updateUsageLimits(testDb.db, {
    dailyGenerationTasks: 40,
    monthlyGenerationTasks: 400,
    resetTimezone: 'UTC',
  });
});

describe.skipIf(skip)('GET /api/chrome', () => {
  it('returns exactly the owner’s { usage, activeSession } — no worker diagnostics', async () => {
    const owner = await createUser(testDb.db);
    const other = await createUser(testDb.db);
    const ownSession = await createSession(testDb.db, { ownerUserId: owner, status: 'active' });
    await createSession(testDb.db, { ownerUserId: other, status: 'active' });

    holder.userId = owner;
    const res = await (await chromeGet(apiRequest())).json();
    expect(res.ok).toBe(true);
    expect(Object.keys(res.data).sort()).toEqual(['activeSession', 'usage']);
    expect(res.data.activeSession?.id).toBe(ownSession);
    // Usage shown in TRACKS: 40 tasks/day × 2 tracks/call = 80.
    expect(res.data.usage.dailyTracksLimit).toBe(80);
    expect(res.data.usage.monthlyTracksLimit).toBe(800);
  });

  it('admits a Member (200, their OWN budget) — never a 401', async () => {
    const member = await createUser(testDb.db);
    await testDb.db.insert(userProfiles).values({ userId: member, role: 'member' });

    holder.userId = member;
    const res = await chromeGet(apiRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    // The Member's own bound (DEFAULT_MEMBER_LIMITS: 10/50 tasks × 2 tracks/call),
    // never the instance budget or the shared Pool.
    expect(body.data.usage.dailyTracksLimit).toBe(20);
    expect(body.data.usage.monthlyTracksLimit).toBe(100);
    expect(body.data.activeSession).toBeNull();
  });

  it('reports no Track limit for an Admin with the Track ceiling off', async () => {
    await updateUsageLimits(testDb.db, { trackCeilingEnabled: false });
    const owner = await createUser(testDb.db);

    holder.userId = owner;
    const res = await (await chromeGet(apiRequest())).json();
    expect(res.data.usage).toMatchObject({
      dailyTracksUsed: 0,
      dailyTracksLimit: null,
      monthlyTracksUsed: 0,
      monthlyTracksLimit: null,
    });
  });

  it('holds a Member to their own budget when the Admin Track ceiling is off', async () => {
    await updateUsageLimits(testDb.db, { trackCeilingEnabled: false });
    const member = await createUser(testDb.db);
    await testDb.db.insert(userProfiles).values({ userId: member, role: 'member' });

    holder.userId = member;
    const body = await (await chromeGet(apiRequest())).json();
    expect(body.data.usage.dailyTracksLimit).toBe(20);
  });

  it('requires sign-in (401)', async () => {
    holder.userId = null;
    expect((await chromeGet(apiRequest())).status).toBe(401);
  });
});
