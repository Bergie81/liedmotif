import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from 'graphile-worker';
import {
  connectTestDb,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));

const { POST: modePost } = await import('@/app/api/sessions/mode/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function postMode(body: unknown) {
  return modePost(
    new Request('http://localhost/api/sessions/mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function readMode(sessionId: string) {
  return testDb.pool
    .query('select session_mode from activity_sessions where id = $1', [sessionId])
    .then((result) => result.rows[0]?.session_mode);
}

async function bufferJobKeys(): Promise<string[]> {
  // The `graphile_worker.jobs` view omits `payload` (0.17), so read the
  // underlying tables the enqueue function writes.
  const { rows } = await testDb.pool.query<{ key: string | null }>(
    `select j.key
       from graphile_worker._private_jobs j
       join graphile_worker._private_tasks t on t.id = j.task_id
      where t.identifier = 'ensure-session-buffer'`,
  );
  return rows.map((row) => row.key).filter((key): key is string => key !== null);
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('session-mode-route-test');
  holder.db = testDb.db;
  // Install the worker's job-queue schema exactly as the worker migrator does
  // (idempotent), so the route's SQL enqueue has its real target.
  await runMigrations({ connectionString: TEST_DATABASE_URL });
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, GENERATION_FIXTURE_TABLES);
  await testDb.pool.query('delete from graphile_worker._private_jobs');
  holder.ownerUserId = null;
});

describe.skipIf(skip)('POST /api/sessions/mode', () => {
  it('switches an owned session between the two generation policies', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId });

    const response = await postMode({ sessionId, mode: 'repeat' });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.session.sessionMode).toBe('repeat');
    expect(await readMode(sessionId)).toBe('repeat');

    expect((await postMode({ sessionId, mode: 'keep_going' })).status).toBe(200);
    expect(await readMode(sessionId)).toBe('keep_going');
  });

  it('enqueues the buffer tick for an active session so the mode takes effect promptly', async () => {
    // Without this, a session switched to Generate new Tracks would wait for
    // the worker's once-per-minute sweep before anything generates. Same job
    // key as the sweep — the two dedupe.
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId, sessionMode: 'repeat' });

    expect((await postMode({ sessionId, mode: 'keep_going' })).status).toBe(200);

    expect(await bufferJobKeys()).toEqual([`buffer:${sessionId}`]);
  });

  it('enqueues no buffer tick for a stopped session', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId, status: 'stopped' });

    expect((await postMode({ sessionId, mode: 'repeat' })).status).toBe(200);

    expect(await bufferJobKeys()).toEqual([]);
  });

  it('is idempotent — re-sending the same mode leaves it standing', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId });

    await postMode({ sessionId, mode: 'repeat' });
    expect((await postMode({ sessionId, mode: 'repeat' })).status).toBe(200);
    expect(await readMode(sessionId)).toBe('repeat');
  });

  it('rejects an unknown mode as a validation error', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId });

    expect((await postMode({ sessionId, mode: 'loop_forever' })).status).toBe(400);
    expect(await readMode(sessionId)).toBe('keep_going');
  });

  it('returns 404 for an unknown or cross-owner session', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = await createUser(testDb.db);

    expect((await postMode({ sessionId, mode: 'repeat' })).status).toBe(404);
    expect(
      (await postMode({ sessionId: '00000000-0000-4000-8000-000000000000', mode: 'repeat' }))
        .status,
    ).toBe(404);
    expect(await readMode(sessionId)).toBe('keep_going');
  });

  it('refuses an unauthenticated caller', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });

    expect((await postMode({ sessionId, mode: 'repeat' })).status).toBe(401);
    expect(await readMode(sessionId)).toBe('keep_going');
  });
});
