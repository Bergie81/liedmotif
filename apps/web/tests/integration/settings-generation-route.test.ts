import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generationSettingsResponseSchema } from '@liedmotif/shared';
import {
  connectTestDb,
  createUser,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// Owner-scoped generation settings route: Buffer enabled state/target and default
// session language — defaults, Zod bounds (1–10 whole tracks, curated language
// vocabulary, strict keys), and admin gating.

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));

const { GET, POST } = await import('@/app/api/settings/generation/route');

/** A same-origin API call: the guards look only at the absent `Origin`. */
const apiRequest = () => new Request('http://localhost/api');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/settings/generation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('settings-generation-route-test');
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

describe.skipIf(skip)('GET/POST /api/settings/generation', () => {
  it('answers the shipped defaults before anything is stored', async () => {
    holder.ownerUserId = await createUser(testDb.db);
    const res = await GET(apiRequest());
    const parsed = generationSettingsResponseSchema.parse(await res.json());
    expect(parsed).toEqual({
      ok: true,
      data: { defaultSessionDurationMinutes: 30, bufferAheadTracks: 3, defaultLanguage: 'auto' },
    });
  });

  it('round-trips the Default Session duration and the ready-ahead target', async () => {
    holder.ownerUserId = await createUser(testDb.db);
    const updated = await post({ defaultSessionDurationMinutes: 120, bufferAheadTracks: 1 });
    expect(await updated.json()).toEqual({
      ok: true,
      data: { defaultSessionDurationMinutes: 120, bufferAheadTracks: 1, defaultLanguage: 'auto' },
    });

    const readBack = await GET(apiRequest());
    const parsed = generationSettingsResponseSchema.parse(await readBack.json());
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.data).toMatchObject({ defaultSessionDurationMinutes: 120, bufferAheadTracks: 1 });
  });

  it('stores No limit as the Default Session duration', async () => {
    holder.ownerUserId = await createUser(testDb.db);
    await post({ defaultSessionDurationMinutes: null });
    const parsed = generationSettingsResponseSchema.parse(await (await GET(apiRequest())).json());
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.data.defaultSessionDurationMinutes).toBeNull();
  });

  it('patches the default language alone and keeps the rest untouched', async () => {
    holder.ownerUserId = await createUser(testDb.db);
    await post({ bufferAheadTracks: 5, defaultSessionDurationMinutes: 15 });
    const updated = await post({ defaultLanguage: 'German' });
    expect(await updated.json()).toEqual({
      ok: true,
      data: { defaultSessionDurationMinutes: 15, bufferAheadTracks: 5, defaultLanguage: 'German' },
    });
  });

  it.each([
    ['a negative buffer', { bufferAheadTracks: -1 }],
    ['a zero buffer target', { bufferAheadTracks: 0 }],
    ['an off-vocabulary language', { defaultLanguage: 'Klingon' }],
    ['a lowercase language (canonical names only)', { defaultLanguage: 'german' }],
    ['a buffer above the 10-track ceiling', { bufferAheadTracks: 11 }],
    ['a fractional track count', { bufferAheadTracks: 2.5 }],
    ['a non-number', { bufferAheadTracks: 'many' }],
    ['a Default Session duration outside its choices', { defaultSessionDurationMinutes: 45 }],
    ['a Buffer on/off switch, which the settings do not hold', { bufferEnabled: false }],
    ['an unknown key (strict contract)', { tracksAhead: 3 }],
  ])('rejects %s with a validation error', async (_name, body) => {
    holder.ownerUserId = await createUser(testDb.db);
    const res = await post(body);
    expect(res.status).toBe(400);
  });

  it('requires the admin session (401 unauthenticated)', async () => {
    expect((await GET(apiRequest())).status).toBe(401);
    expect((await post({ bufferAheadTracks: 5 })).status).toBe(401);
  });
});
