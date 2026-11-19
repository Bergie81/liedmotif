import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listeningStatsResponseSchema } from '@liedmotif/shared';
import { getPersonalization } from '@liedmotif/db';
import {
  connectTestDb,
  GENERATION_FIXTURE_TABLES,
  seedReadyTrack,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// The route boundary of personal listening analytics: auth, contract validation,
// ownership, and the report → stats round trip. Accounting rules live in the repo suite.

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));

const report = (await import('@/app/api/listening/report/route')).POST;
const stats = (await import('@/app/api/listening/stats/route')).GET;
const clearHistory = (await import('@/app/api/listening/clear-history/route')).POST;
const personalization = (await import('@/app/api/listening/personalization/route')).POST;
const resetTaste = (await import('@/app/api/listening/reset-taste/route')).POST;

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function json(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function reportBody(seeded: { trackId: string; sessionId: string }, listenedMs = 60_000) {
  const now = Date.now();
  return {
    occurrenceId: '00000000-0000-4000-8000-000000000001',
    trackId: seeded.trackId,
    sessionId: seeded.sessionId,
    surface: 'session',
    startedAt: new Date(now - listenedMs).toISOString(),
    origin: 'user',
    listenedMs,
    playedMs: listenedMs,
    clientTimestamp: new Date(now).toISOString(),
    endReason: null,
  };
}

async function readStats(range?: string) {
  const response = await stats(
    new Request(`http://localhost/api/listening/stats${range ? `?range=${range}` : ''}`),
  );
  const parsed = listeningStatsResponseSchema.parse(await response.json());
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.data;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('listening-routes-test');
  holder.db = testDb.db;
});
afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});
beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, [
    'listening_occurrences',
    'listening_preferences',
    'user_settings',
    ...GENERATION_FIXTURE_TABLES,
  ]);
  holder.ownerUserId = null;
});

describe.skipIf(skip)('listening routes', () => {
  it('a reported Session listen shows up in the default 30-day stats', async () => {
    const seeded = await seedReadyTrack(testDb.db);
    holder.ownerUserId = seeded.ownerUserId;

    expect((await report(json('/api/listening/report', reportBody(seeded)))).status).toBe(200);

    const data = await readStats();
    expect(data).toMatchObject({
      range: '30d',
      listenedMs: 60_000,
      qualifyingPlays: 1,
      uniqueTracks: 1,
      topTracks: [{ trackId: seeded.trackId, plays: 1 }],
    });
    expect(data.topGenres.reduce((sum, entry) => sum + entry.listenedMs, 0)).toBe(60_000);
    expect(data.timezone).toBeTruthy();
  });

  it("answers not_found for another owner's Track and leaves both owners' stats empty", async () => {
    const mine = await seedReadyTrack(testDb.db);
    const theirs = await seedReadyTrack(testDb.db);
    holder.ownerUserId = mine.ownerUserId;

    const response = await report(
      json('/api/listening/report', reportBody({ ...mine, trackId: theirs.trackId })),
    );
    expect(response.status).toBe(404);
    expect((await readStats()).listenedMs).toBe(0);
    holder.ownerUserId = theirs.ownerUserId;
    expect((await readStats()).listenedMs).toBe(0);
  });

  it('counts Playlist and preview reports with no Session, and refuses a surface it does not know', async () => {
    const seeded = await seedReadyTrack(testDb.db);
    holder.ownerUserId = seeded.ownerUserId;
    const body = (surface: string, n: number) => ({
      ...reportBody(seeded, 40_000),
      occurrenceId: `00000000-0000-4000-8000-00000000001${n}`,
      sessionId: null,
      surface,
    });

    expect((await report(json('/api/listening/report', body('playlist', 1)))).status).toBe(200);
    expect((await report(json('/api/listening/report', body('preview', 2)))).status).toBe(200);
    expect((await report(json('/api/listening/report', body('lounge', 3)))).status).toBe(400);

    expect(await readStats()).toMatchObject({ listenedMs: 80_000, qualifyingPlays: 2 });
  });

  it("records nothing for either party when a Visitor plays an owner's Lounge Playlist", async () => {
    const visitor = await seedReadyTrack(testDb.db);
    const owner = await seedReadyTrack(testDb.db);
    holder.ownerUserId = visitor.ownerUserId;

    const response = await report(
      json('/api/listening/report', {
        ...reportBody(owner),
        sessionId: null,
        surface: 'playlist',
      }),
    );
    expect(response.status).toBe(404);
    expect((await readStats('all')).listenedMs).toBe(0);
    holder.ownerUserId = owner.ownerUserId;
    expect((await readStats('all')).listenedMs).toBe(0);
  });

  it('rejects client-supplied musical attributes instead of trusting them', async () => {
    const seeded = await seedReadyTrack(testDb.db);
    holder.ownerUserId = seeded.ownerUserId;
    const response = await report(
      json('/api/listening/report', { ...reportBody(seeded), genreTags: ['polka'] }),
    );
    expect(response.status).toBe(400);
  });

  it("clears only the caller's listening, and a retry of an earlier report stays refused", async () => {
    const mine = await seedReadyTrack(testDb.db);
    const theirs = await seedReadyTrack(testDb.db);
    holder.ownerUserId = theirs.ownerUserId;
    await report(json('/api/listening/report', reportBody(theirs)));
    holder.ownerUserId = mine.ownerUserId;
    const body = reportBody(mine);
    await report(json('/api/listening/report', body));
    expect((await readStats('all')).qualifyingPlays).toBe(1);

    const cleared = await clearHistory(json('/api/listening/clear-history', {}));
    expect(cleared.status).toBe(200);
    expect((await report(json('/api/listening/report', body))).status).toBe(400);

    expect(await readStats('all')).toMatchObject({ listenedMs: 0, qualifyingPlays: 0 });
    holder.ownerUserId = theirs.ownerUserId;
    expect((await readStats('all')).qualifyingPlays).toBe(1);
  });

  it("switches and resets only the caller's learned taste, leaving stats alone", async () => {
    const mine = await seedReadyTrack(testDb.db);
    const theirs = await seedReadyTrack(testDb.db);
    holder.ownerUserId = mine.ownerUserId;
    await report(json('/api/listening/report', reportBody(mine)));

    const off = await personalization(json('/api/listening/personalization', { enabled: false }));
    expect(await off.json()).toMatchObject({ ok: true, data: { enabled: false } });
    expect(await getPersonalization(testDb.db, mine.ownerUserId)).toEqual({ enabled: false });
    expect(await getPersonalization(testDb.db, theirs.ownerUserId)).toEqual({ enabled: true });
    expect(
      (await personalization(json('/api/listening/personalization', { enabled: 'no' }))).status,
    ).toBe(400);

    const reset = await resetTaste(json('/api/listening/reset-taste', {}));
    expect(await reset.json()).toMatchObject({ ok: true, data: { reset: true } });
    expect((await readStats('all')).qualifyingPlays).toBe(1);
  });

  it('requires a signed-in user on every route', async () => {
    const seeded = await seedReadyTrack(testDb.db);
    expect((await report(json('/api/listening/report', reportBody(seeded)))).status).toBe(401);
    expect((await stats(new Request('http://localhost/api/listening/stats'))).status).toBe(401);
    expect((await clearHistory(json('/api/listening/clear-history', {}))).status).toBe(401);
    expect(
      (await personalization(json('/api/listening/personalization', { enabled: true }))).status,
    ).toBe(401);
    expect((await resetTaste(json('/api/listening/reset-taste', {}))).status).toBe(401);
  });
});
