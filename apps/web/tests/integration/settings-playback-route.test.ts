import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { playbackSettingsResponseSchema } from '@liedmotif/shared';
import {
  connectTestDb,
  createUser,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// Owner-scoped playback settings route:
// defaults, Zod bounds (crossfade 2–12 s, strict keys), and admin gating.

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));

const { GET, POST } = await import('@/app/api/settings/playback/route');

/** A same-origin API call: the guards look only at the absent `Origin`. */
const apiRequest = () => new Request('http://localhost/api');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/settings/playback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('settings-playback-route-test');
  holder.db = testDb.db;
});
afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});
beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, ['user_settings', 'user']);
  holder.ownerUserId = null;
});

describe.skipIf(skip)('GET/POST /api/settings/playback', () => {
  it('answers the shipped defaults before anything is stored', async () => {
    holder.ownerUserId = await createUser(testDb.db);
    const res = await GET(apiRequest());
    const parsed = playbackSettingsResponseSchema.parse(await res.json());
    expect(parsed).toEqual({ ok: true, data: { blendEnabled: true, crossfadeSeconds: 6 } });
  });

  it('applies a partial patch and round-trips it', async () => {
    holder.ownerUserId = await createUser(testDb.db);
    const updated = await post({ crossfadeSeconds: 10 });
    expect(await updated.json()).toEqual({
      ok: true,
      data: { blendEnabled: true, crossfadeSeconds: 10 },
    });

    const readBack = await GET(apiRequest());
    const parsed = playbackSettingsResponseSchema.parse(await readBack.json());
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.data.crossfadeSeconds).toBe(10);
  });

  it.each([
    ['crossfade below the 2 s floor', { crossfadeSeconds: 1 }],
    ['crossfade above the 12 s ceiling', { crossfadeSeconds: 13 }],
    ['a non-boolean blend toggle', { blendEnabled: 'yes' }],
    ['an unknown key (strict contract)', { volume: 0.5 }],
  ])('rejects %s with a validation error', async (_name, body) => {
    holder.ownerUserId = await createUser(testDb.db);
    const res = await post(body);
    expect(res.status).toBe(400);
  });

  it('requires the admin session (401 unauthenticated)', async () => {
    expect((await GET(apiRequest())).status).toBe(401);
    expect((await post({ blendEnabled: false })).status).toBe(401);
  });
});
