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
import { generationRequests, updateUsageLimits, writeWorkerHeartbeat } from '@liedmotif/db';
import { runMigrations } from 'graphile-worker';

// Owner-scoped library + track-detail + diagnostics reads. The library
// lists ONLY the caller's saved tracks (no cross-owner leakage); track detail rejects
// cross-owner/malformed ids; diagnostics returns the caller's active session + usage
// (in tracks) and leaks no secret.

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
vi.mock('@/lib/providers', () => ({
  getTypicalTracksPerMusicRequest: () => 2,
  getLlmProvider: async () => null,
  getStorageProvider: () => ({ providerKey: 'local-fs' }),
}));

const { GET: libraryGet } = await import('@/app/api/library/route');
const { GET: trackGet } = await import('@/app/api/tracks/[trackId]/route');
const { GET: diagnosticsGet } = await import('@/app/api/diagnostics/route');

/** A same-origin API call: the guards look only at the absent `Origin`. */
const apiRequest = () => new Request('http://localhost/api');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function getWithQuery(handler: (r: Request) => Promise<Response>, query: Record<string, string>) {
  const url = new URL('http://localhost/api');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return handler(new Request(url));
}

let seedCounter = 0;
async function seedTrack(ownerUserId: string, sessionId?: string) {
  seedCounter += 1;
  const sid = sessionId ?? (await createSession(testDb.db, { ownerUserId }));
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    activitySessionId: sid,
  });
  const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  const trackId = await createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId: jobId,
    audioStorageKey: `lib/${ownerUserId}/${seedCounter}.mp3`,
  });
  return { sid, trackId };
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('library-diagnostics-routes-test');
  holder.db = testDb.db;
  // The worker-status queue counts read the graphile jobs view — install the
  // schema exactly as the worker migrator does (idempotent) so they are
  // deterministic here rather than dependent on which suites ran before.
  await runMigrations({ connectionString: TEST_DATABASE_URL! });
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, [...GENERATION_FIXTURE_TABLES, 'app_settings']);
  await testDb.pool.query('delete from graphile_worker._private_jobs');
  holder.ownerUserId = null;
  await updateUsageLimits(testDb.db, {
    dailyGenerationTasks: 40,
    monthlyGenerationTasks: 400,
    resetTimezone: 'UTC',
  });
});

describe.skipIf(skip)('GET /api/library', () => {
  it('lists ONLY the owner’s saved tracks with an app-routed audioUrl (no IDOR)', async () => {
    const owner = await createUser(testDb.db);
    const other = await createUser(testDb.db);
    const mine = await seedTrack(owner);
    const theirs = await seedTrack(other);
    await testDb.pool.query('update tracks set saved_at = now() where id = any($1)', [
      [mine.trackId, theirs.trackId],
    ]);

    holder.ownerUserId = owner;
    const res = await (await getWithQuery(libraryGet, { view: 'saved' })).json();
    expect(res.ok).toBe(true);
    expect(res.data.view).toBe('saved');
    const ids = res.data.items.map((t: { id: string }) => t.id);
    expect(ids).toEqual([mine.trackId]);
    expect(ids).not.toContain(theirs.trackId);
    // Audio is exposed only as a same-origin app path.
    expect(res.data.items[0].audioUrl).toBe(`/api/audio/${mine.trackId}`);
  });

  it('rejects an invalid view (validation_error) and requires sign-in (401)', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    expect((await getWithQuery(libraryGet, { view: 'bogus' })).status).toBe(400);

    holder.ownerUserId = null;
    expect((await getWithQuery(libraryGet, { view: 'saved' })).status).toBe(401);
  });
});

describe.skipIf(skip)('GET /api/library — cursor validation (no DB cast 500)', () => {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

  async function expectInvalidCursor(cursor: string) {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const res = await getWithQuery(libraryGet, { view: 'saved', cursor });
    // The SAME consistent envelope all other routes use for bad input — never a 500.
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('validation_error');
  }

  it('rejects a non-base64 / non-JSON cursor with the validation_error envelope', async () => {
    await expectInvalidCursor('!!!not-a-valid-cursor!!!');
  });

  it('rejects a base64 cursor whose payload is not JSON', async () => {
    await expectInvalidCursor(b64('hello world, not json'));
  });

  it('rejects a base64 JSON cursor with an invalid timestamp and uuid', async () => {
    await expectInvalidCursor(b64(JSON.stringify({ t: 'bad', id: 'bad' })));
  });

  it('rejects a base64 JSON cursor with a non-timestamptz t (would 500 at ::timestamptz)', async () => {
    // `Date.parse("2026")` is NOT NaN, but `'2026'::timestamptz` errors — must still be rejected.
    await expectInvalidCursor(
      b64(JSON.stringify({ t: '2026', id: '00000000-0000-4000-8000-000000000001' })),
    );
  });

  it('rejects a calendar-invalid t that Date.parse silently normalizes (Feb 30 → Postgres rejects)', async () => {
    // `Date.parse("2026-02-30T00:00:00Z")` is NOT NaN (it shifts to Mar 2), but
    // `'2026-02-30…'::timestamptz` errors — so this must yield validation_error, not 500.
    await expectInvalidCursor(
      b64(
        JSON.stringify({ t: '2026-02-30T00:00:00Z', id: '00000000-0000-4000-8000-000000000001' }),
      ),
    );
  });

  it('rejects other calendar-invalid / out-of-range t values (Apr 31, hour 25)', async () => {
    await expectInvalidCursor(
      b64(
        JSON.stringify({ t: '2026-04-31T00:00:00Z', id: '00000000-0000-4000-8000-000000000002' }),
      ),
    );
    await expectInvalidCursor(
      b64(
        JSON.stringify({ t: '2026-06-20T25:00:00Z', id: '00000000-0000-4000-8000-000000000003' }),
      ),
    );
  });

  it('still paginates correctly with a valid round-trip cursor (happy path unchanged)', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId: owner });
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { trackId } = await seedTrack(owner, sessionId);
      await testDb.pool.query('update tracks set saved_at = $1 where id = $2', [
        new Date(Date.UTC(2026, 5, 20, 12, 0, i)),
        trackId,
      ]);
      ids.push(trackId);
    }

    holder.ownerUserId = owner;
    const page1 = await (await getWithQuery(libraryGet, { view: 'saved', limit: '2' })).json();
    expect(page1.ok).toBe(true);
    expect(page1.data.items).toHaveLength(2);
    expect(page1.data.nextCursor).not.toBeNull();

    const page2 = await (
      await getWithQuery(libraryGet, { view: 'saved', limit: '2', cursor: page1.data.nextCursor })
    ).json();
    expect(page2.ok).toBe(true);
    expect(page2.data.items).toHaveLength(1);

    const seen = [...page1.data.items, ...page2.data.items].map((t: { id: string }) => t.id).sort();
    expect(seen).toEqual([...ids].sort());
  });
});

describe.skipIf(skip)('GET /api/tracks/[trackId]', () => {
  function callDetail(trackId: string) {
    return trackGet(new Request('http://localhost/api/tracks/' + trackId), {
      params: Promise.resolve({ trackId }),
    });
  }

  it('returns the owner’s track summary; 404 for cross-owner / malformed; 401 signed out', async () => {
    const owner = await createUser(testDb.db);
    const { trackId } = await seedTrack(owner);

    holder.ownerUserId = owner;
    const ok = await (await callDetail(trackId)).json();
    expect(ok.ok).toBe(true);
    expect(ok.data.id).toBe(trackId);

    // Cross-owner id is indistinguishable from missing (404 — no IDOR).
    const attacker = await createUser(testDb.db);
    holder.ownerUserId = attacker;
    expect((await callDetail(trackId)).status).toBe(404);

    // A malformed id never reaches the DB.
    expect((await callDetail('not-a-uuid')).status).toBe(404);

    holder.ownerUserId = null;
    expect((await callDetail(trackId)).status).toBe(401);
  });
});

describe.skipIf(skip)('GET /api/diagnostics', () => {
  it('returns the caller’s active session + usage (in tracks); never another owner’s session', async () => {
    const owner = await createUser(testDb.db);
    const other = await createUser(testDb.db);
    const ownerSession = await createSession(testDb.db, { ownerUserId: owner, status: 'active' });
    await createSession(testDb.db, { ownerUserId: other, status: 'active' });

    holder.ownerUserId = owner;
    const res = await (await diagnosticsGet(apiRequest())).json();
    expect(res.ok).toBe(true);
    expect(res.data.activeSession?.id).toBe(ownerSession);
    // Usage shown in TRACKS: 40 tasks/day × 2 tracks/call = 80.
    expect(res.data.usage.dailyTracksLimit).toBe(80);
    expect(res.data.usage.monthlyTracksLimit).toBe(800);
    expect(res.data.usage.minHeadroomTracksToStartSession).toBe(5);
    // Never-reported worker: the heartbeat-derived fields are null/stale, while
    // the queue and ledger sources exist here (schema installed, no rows) and
    // honestly report zeros.
    expect(res.data.worker).toEqual({
      heartbeatAt: null,
      stale: true,
      state: null,
      concurrency: null,
      jobsInFlight: 0,
      queuedJobs: 0,
      failedJobs: 0,
      lastProviderPoll: null,
      retriesToday: 0,
      events: [],
    });
    expect(res.data.providers).toEqual([]);
  });

  it('surfaces a live worker: heartbeat, queue counts, provider poll, and sanitized events', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const now = new Date();
    await writeWorkerHeartbeat(testDb.db, {
      ts: now.toISOString(),
      pid: 4242,
      state: 'ready',
      concurrency: 2,
      startedAt: now.toISOString(),
    });
    await testDb.pool.query(`select graphile_worker.add_job('diagnostics-test-job')`);
    await seedTrack(owner);
    // A terminal failure feeds the warn event path (error code + safe message).
    await testDb.db.insert(generationRequests).values({
      ownerUserId: owner,
      source: 'controls',
      providerType: 'music',
      providerKey: 'mock',
      status: 'failed',
      errorCode: 'GENERATE_AUDIO_FAILED',
      errorMessageSafe: 'The provider rejected the request.',
    });

    const res = await (await diagnosticsGet(apiRequest())).json();
    expect(res.ok).toBe(true);
    expect(res.data.worker).toMatchObject({
      heartbeatAt: now.toISOString(),
      stale: false,
      state: 'ready',
      concurrency: 2,
      jobsInFlight: 0,
      queuedJobs: 1,
      failedJobs: 0,
    });
    // seedTrack materializes a submitted provider job → poll recency exists.
    expect(res.data.worker.lastProviderPoll).toMatchObject({ status: 'ready' });
    // Download (info) and terminal-failure (warn) events both derive; the feed
    // carries ids, codes, and timings only — never URLs, keys, or prompt text.
    const failureEvent = res.data.worker.events.find(
      (event: { level: string }) => event.level === 'warn',
    );
    expect(failureEvent?.message).toMatch(/failed · GENERATE_AUDIO_FAILED/);
    expect(res.data.worker.events.length).toBeGreaterThan(1);
    for (const event of res.data.worker.events) {
      expect(event.message).not.toMatch(/http|key|secret/i);
    }
  });

  it('returns a null active session when nothing is playing, and leaks no secret', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    process.env.SUNO_API_KEY = 'super-secret-provider-key-xyz';

    const res = await diagnosticsGet(apiRequest());
    const body = await res.text();
    expect(body).not.toContain('super-secret-provider-key-xyz');
    const parsed = JSON.parse(body);
    expect(parsed.data.activeSession).toBeNull();

    delete process.env.SUNO_API_KEY;
  });

  it('requires sign-in (401)', async () => {
    holder.ownerUserId = null;
    expect((await diagnosticsGet(apiRequest())).status).toBe(401);
  });
});
