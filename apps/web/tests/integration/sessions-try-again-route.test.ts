import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { runMigrations } from 'graphile-worker';
import { activitySessions, generationRequests } from '@liedmotif/db';
import { tryAgainSessionResponseSchema } from '@liedmotif/shared';
import {
  connectTestDb,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// Try again records the listener's restart and wakes the buffer controller in
// the same request, as Resume does. It submits nothing itself: the worker's
// tick is the only place that spends. Runs against the REAL `graphile_worker`
// schema, so what is asserted is the actual queued job.

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));

const { POST: tryAgain } = await import('@/app/api/sessions/try-again/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

async function bufferJobKeys(): Promise<string[]> {
  const { rows } = await testDb.pool.query<{ key: string | null }>(
    `select j.key
       from graphile_worker._private_jobs j
       join graphile_worker._private_tasks t on t.id = j.task_id
      where t.identifier = 'ensure-session-buffer'`,
  );
  return rows.map((row) => row.key ?? '');
}

function post(sessionId: string): Promise<Response> {
  return tryAgain(
    new Request('http://localhost/api/sessions/try-again', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }),
  );
}

async function lastResumedAt(sessionId: string): Promise<Date | null> {
  const [row] = await testDb.db
    .select({ lastResumedAt: activitySessions.lastResumedAt })
    .from(activitySessions)
    .where(eq(activitySessions.id, sessionId));
  return row!.lastResumedAt;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('sessions-try-again-route-test');
  holder.db = testDb.db;
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
  holder.ownerUserId = await createUser(testDb.db);
});

describe.skipIf(skip)('POST /api/sessions/try-again', () => {
  it('records the restart on the owner’s Active Session and wakes the buffer controller', async () => {
    const sessionId = await createSession(testDb.db, {
      ownerUserId: holder.ownerUserId!,
      status: 'active',
      generationStatus: 'provider_error',
    });

    const res = await post(sessionId);
    const parsed = tryAgainSessionResponseSchema.parse(await res.json());
    expect(parsed).toEqual({ ok: true, data: { id: sessionId } });

    expect(await lastResumedAt(sessionId)).not.toBeNull();
    expect(await bufferJobKeys()).toEqual([`buffer:${sessionId}`]);
    // Nothing is bought in the request itself.
    expect(await testDb.db.select().from(generationRequests)).toHaveLength(0);
  });

  it('refuses a Stopped Session as a conflict and records nothing', async () => {
    const sessionId = await createSession(testDb.db, {
      ownerUserId: holder.ownerUserId!,
      status: 'stopped',
    });

    const res = await post(sessionId);
    expect(res.status).toBe(409);
    expect(await lastResumedAt(sessionId)).toBeNull();
    expect(await bufferJobKeys()).toEqual([]);
  });

  it('answers not found for another owner’s Session and a missing one', async () => {
    const otherOwner = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId: otherOwner, status: 'active' });

    expect((await post(sessionId)).status).toBe(404);
    expect((await post('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect(await lastResumedAt(sessionId)).toBeNull();
    expect(await bufferJobKeys()).toEqual([]);
  });
});
