import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectTestDb, TEST_DATABASE_URL, type TestDb } from '@liedmotif/db/testing';
import { getUsageLimits, updateUsageLimits } from '@liedmotif/db';
import { USAGE_LIMIT_CEILINGS } from '@liedmotif/shared';

// POST /api/settings/limits: a limit field updates only from an actual
// non-negative whole NUMBER. `Number('')` is 0, so a coercing route would let an
// API caller (or a form bug) silently zero a cost limit with `""`/`null` — the
// route must reject those as bad requests and leave the stored limits untouched.

const holder = vi.hoisted(() => ({ db: null as unknown, admin: false }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.admin ? { user: { id: 'admin-1' } } : null),
  getAppSession: async () => (holder.admin ? { user: { id: 'admin-1' } } : null),
}));

const { POST: limitsPost } = await import('@/app/api/settings/limits/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function postJson(body: unknown) {
  return limitsPost(
    new Request('http://localhost/api/settings/limits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('settings-limits-route-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  holder.admin = true;
  await updateUsageLimits(testDb.db, {
    dailyGenerationTasks: 12,
    monthlyGenerationTasks: 120,
    resetTimezone: 'UTC',
  });
});

describe.skipIf(skip)('POST /api/settings/limits', () => {
  it('rejects the request without an admin session', async () => {
    holder.admin = false;
    const res = await postJson({ dailyGenerationTasks: 5 });
    expect(res.status).toBe(401);
  });

  it('updates a limit from a number and allows an explicit 0', async () => {
    const ok = await postJson({ dailyGenerationTasks: 5 });
    expect(ok.status).toBe(200);
    expect((await getUsageLimits(testDb.db)).dailyGenerationTasks).toBe(5);

    // An intentional 0 (block all generation) stays valid — only coerced
    // empties are refused.
    const zero = await postJson({ dailyGenerationTasks: 0 });
    expect(zero.status).toBe(200);
    expect((await getUsageLimits(testDb.db)).dailyGenerationTasks).toBe(0);
  });

  it('updates the storage quota as an exact non-negative byte count', async () => {
    const storageQuotaBytes = 12 * 1024 ** 3;
    const response = await postJson({ storageQuotaBytes });

    expect(response.status).toBe(200);
    expect((await getUsageLimits(testDb.db)).storageQuotaBytes).toBe(storageQuotaBytes);
  });

  it('refuses a queue depth of 0 and accepts 1', async () => {
    expect((await postJson({ maxQueuedTracks: 1 })).status).toBe(200);
    const refused = await postJson({ maxQueuedTracks: 0 });
    expect(refused.status).toBe(400);
    expect((await refused.json()) as { error: string }).toMatchObject({
      error: 'maxQueuedTracks must be at least 1.',
    });
    expect((await getUsageLimits(testDb.db)).maxQueuedTracks).toBe(1);
  });

  it('leaves omitted fields untouched (partial patch)', async () => {
    const res = await postJson({ dailyGenerationTasks: 7 });
    expect(res.status).toBe(200);
    const limits = await getUsageLimits(testDb.db);
    expect(limits.dailyGenerationTasks).toBe(7);
    expect(limits.monthlyGenerationTasks).toBe(120);
  });

  it.each([
    ['empty string', ''],
    ['null', null],
    ['numeric string', '5'],
    ['fraction', 1.5],
    ['negative', -1],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects %s without changing the stored limit', async (_label, value) => {
    const res = await postJson({ dailyGenerationTasks: value });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
    expect((await getUsageLimits(testDb.db)).dailyGenerationTasks).toBe(12);
  });

  it.each(Object.entries(USAGE_LIMIT_CEILINGS))(
    'accepts %s at its ceiling and refuses one above it',
    async (key, ceiling) => {
      // A limit no spend can ever reach is the cost controls switched off.
      expect((await postJson({ [key]: ceiling })).status).toBe(200);
      const refused = await postJson({ [key]: ceiling + 1 });
      expect(refused.status).toBe(400);
      expect((await getUsageLimits(testDb.db))[key as keyof typeof USAGE_LIMIT_CEILINGS]).toBe(
        ceiling,
      );
    },
  );

  it('switches the Admin Track ceiling off and on', async () => {
    expect((await postJson({ trackCeilingEnabled: false })).status).toBe(200);
    expect((await getUsageLimits(testDb.db)).trackCeilingEnabled).toBe(false);

    expect((await postJson({ trackCeilingEnabled: true })).status).toBe(200);
    expect((await getUsageLimits(testDb.db)).trackCeilingEnabled).toBe(true);
  });

  it('switches the Admin Cover ceiling off and on', async () => {
    expect((await postJson({ coverCeilingEnabled: false })).status).toBe(200);
    expect((await getUsageLimits(testDb.db)).coverCeilingEnabled).toBe(false);

    expect((await postJson({ coverCeilingEnabled: true })).status).toBe(200);
    expect((await getUsageLimits(testDb.db)).coverCeilingEnabled).toBe(true);
  });

  it('stores a reset timezone on its own, as onboarding sends it', async () => {
    const res = await postJson({ resetTimezone: 'Europe/Berlin' });
    expect(res.status).toBe(200);
    const limits = await getUsageLimits(testDb.db);
    expect(limits.resetTimezone).toBe('Europe/Berlin');
    // The zone-only patch is the whole body onboarding's profile step sends.
    expect(limits.dailyGenerationTasks).toBe(12);
  });

  it.each([
    ['unknown zone', 'Mars/Olympus_Mons'],
    ['empty string', ''],
    ['non-string', 60],
  ])(
    'refuses a %s reset timezone, which would break the window boundary',
    async (_label, value) => {
      const res = await postJson({ resetTimezone: value });
      expect(res.status).toBe(400);
      expect((await getUsageLimits(testDb.db)).resetTimezone).toBe('UTC');
    },
  );

  it.each([
    ['top-level null', null],
    ['array', []],
    ['number', 42],
    ['string', 'nope'],
  ])('rejects a %s body without changing the stored limits', async (_label, body) => {
    const res = await postJson(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    expect((await getUsageLimits(testDb.db)).dailyGenerationTasks).toBe(12);
  });
});
