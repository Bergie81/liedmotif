import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createSession,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { listSessionsResponseSchema } from '@liedmotif/shared';

// My Sessions cursor validation: a tampered cursor must surface as the
// SAME `validation_error` envelope the library route uses — never a raw Postgres
// `::timestamptz`/`::uuid` cast failure (a 500). Mirrors the library route's
// cursor tests; the codec is shared (`parseKeysetCursor`).

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
vi.mock('@/lib/providers', () => ({
  getMusicProvider: () => ({
    providerKey: 'mock',
    getCapabilities: () => ({ typicalTracksPerRequest: 2 }),
  }),
  getLlmProvider: async () => null,
  getStorageProvider: () => ({ providerKey: 'local-fs' }),
}));

const { GET: sessionsGet } = await import('@/app/api/sessions/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function getSessions(query: Record<string, string>) {
  const url = new URL('http://localhost/api/sessions');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return sessionsGet(new Request(url));
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('sessions-cursor-route-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, GENERATION_FIXTURE_TABLES);
  holder.ownerUserId = null;
});

describe.skipIf(skip)('GET /api/sessions — cursor validation (no DB cast 500)', () => {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

  async function expectInvalidCursor(cursor: string) {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const res = await getSessions({ cursor });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('validation_error');
  }

  it('rejects a non-base64 / non-JSON cursor with the validation_error envelope', async () => {
    await expectInvalidCursor('!!!not-a-valid-cursor!!!');
  });

  it('rejects a base64 JSON cursor with an invalid timestamp and uuid', async () => {
    await expectInvalidCursor(b64(JSON.stringify({ t: 'bad', id: 'bad' })));
  });

  it('rejects a non-timestamptz t that Date.parse accepts (would 500 at ::timestamptz)', async () => {
    await expectInvalidCursor(
      b64(JSON.stringify({ t: '2026', id: '00000000-0000-4000-8000-000000000001' })),
    );
  });

  it('still paginates correctly with a valid round-trip cursor (happy path unchanged)', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    for (let i = 0; i < 3; i += 1) {
      await createSession(testDb.db, {
        ownerUserId: owner,
        status: 'stopped',
        startedAt: new Date(Date.UTC(2026, 0, 1 + i)),
      });
    }

    const page1 = await (await getSessions({ limit: '2' })).json();
    expect(page1.ok).toBe(true);
    expect(page1.data.items).toHaveLength(2);
    expect(page1.data.nextCursor).toBeTruthy();

    const page2 = await (await getSessions({ limit: '2', cursor: page1.data.nextCursor })).json();
    expect(page2.ok).toBe(true);
    expect(page2.data.items).toHaveLength(1);
    const ids = [...page1.data.items, ...page2.data.items].map((s: { id: string }) => s.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('optionally returns the owner’s Active Session with Track-derived activity', async () => {
    const owner = await createUser(testDb.db);
    const other = await createUser(testDb.db);
    const activeSessionId = await createSession(testDb.db, { ownerUserId: owner });
    await createSession(testDb.db, { ownerUserId: other });
    const requestId = await createGenerationRequest(testDb.db, {
      ownerUserId: owner,
      activitySessionId: activeSessionId,
    });
    const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
    await createTrack(testDb.db, {
      ownerUserId: owner,
      generationRequestId: requestId,
      providerJobId: jobId,
      genreTags: ['lofi', 'ambient'],
      audioStorageKey: 'test/active-session.mp3',
    });
    holder.ownerUserId = owner;

    const withoutActive = await (await getSessions({})).json();
    expect(withoutActive.data.activeSession).toBeNull();

    const withActive = await (await getSessions({ includeActive: 'true' })).json();
    expect(listSessionsResponseSchema.safeParse(withActive).success).toBe(true);
    expect(withActive.data.activeSession).toMatchObject({
      id: activeSessionId,
      trackCount: 1,
      genreTags: ['ambient', 'lofi'],
    });
  });
});
