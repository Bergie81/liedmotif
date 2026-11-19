import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSessionById, withOwnerGenerationLock } from '@liedmotif/db';
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
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));

const { POST: durationPost } = await import('@/app/api/sessions/duration/route');
const { POST: changeVibePost } = await import('@/app/api/sessions/change-vibe/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postDuration(body: unknown) {
  return durationPost(jsonRequest('/api/sessions/duration', body));
}

function postChangeVibe(body: unknown) {
  return changeVibePost(jsonRequest('/api/sessions/change-vibe', body));
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
  testDb = await connectTestDb('session-duration-route-test');
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

describe.skipIf(skip)('POST /api/sessions/duration', () => {
  it('a duration edit without an intent is not a Change Vibe', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId });
    const response = await postChangeVibe({ sessionId, targetDurationMinutes: 12 });
    expect(response.status).toBe(400);
    const after = await getSessionById(testDb.db, { ownerUserId, sessionId });
    expect(after!.targetDurationMinutes).toBeNull();
  });

  it('sets, preserves, and clears exact targets without changing Session identity', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId });
    for (const target of [12, 480, null]) {
      const response = await postDuration({ sessionId, targetDurationMinutes: target });
      expect(response.status).toBe(200);
      expect((await response.json()).data.session).toMatchObject({
        id: sessionId,
        targetDurationMinutes: target,
      });
      const unchanged = await postDuration({ sessionId });
      expect((await unchanged.json()).data.session.targetDurationMinutes).toBe(target);
    }
    expect(await bufferJobKeys()).toEqual([`buffer:${sessionId}`]);
  });
  it('setting a target puts a Repeat Session on Keep Going; clearing leaves the mode alone', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId, sessionMode: 'repeat' });

    const cleared = await postDuration({ sessionId, targetDurationMinutes: null });
    expect((await cleared.json()).data.session.sessionMode).toBe('repeat');

    const set = await postDuration({ sessionId, targetDurationMinutes: 30 });
    expect((await set.json()).data.session.sessionMode).toBe('keep_going');
  });

  it('rejects invalid bounds and private Session edits without changing the target', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId });
    await postDuration({ sessionId, targetDurationMinutes: 12 });
    for (const target of [0, -1, 601, 2.5, '20']) {
      expect((await postDuration({ sessionId, targetDurationMinutes: target })).status).toBe(400);
    }
    holder.ownerUserId = await createUser(testDb.db);
    expect((await postDuration({ sessionId })).status).toBe(404);
    expect((await postDuration({ sessionId, targetDurationMinutes: null })).status).toBe(404);
    holder.ownerUserId = null;
    expect((await postDuration({ sessionId, targetDurationMinutes: 30 })).status).toBe(401);
    expect(
      (await getSessionById(testDb.db, { ownerUserId, sessionId }))!.targetDurationMinutes,
    ).toBe(12);
  });

  it('waits for generation admission serialization before applying a target edit', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId });
    let unlock!: () => void;
    let acquired!: () => void;
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const observer = await connectTestDb('duration-lock-observer');
    const admission = withOwnerGenerationLock(testDb.db, ownerUserId, async () => {
      acquired();
      await release;
    });
    await locked;
    const editing = postDuration({ sessionId, targetDurationMinutes: 30 });
    try {
      await vi.waitFor(async () => {
        const result = await observer.pool.query(
          "select 1 from pg_locks where locktype = 'advisory' and not granted",
        );
        expect(result.rowCount).toBeGreaterThan(0);
      });
      expect(
        (await getSessionById(observer.db, { ownerUserId, sessionId }))!.targetDurationMinutes,
      ).toBeNull();
    } finally {
      unlock();
      await observer.pool.end();
    }
    await admission;
    expect((await (await editing).json()).data.session.targetDurationMinutes).toBe(30);
  });
});
