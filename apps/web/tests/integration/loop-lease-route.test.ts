import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loopLeaseResponseSchema } from '@liedmotif/shared';
import {
  connectTestDb,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// The acknowledged loop-lease endpoint. The
// protocol rules themselves are exercised in the repo suite; this covers the
// route boundary: contract validation, ownership (404), auth (401), and that the
// response is the ACKNOWLEDGED applied state.

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
const kicks = vi.hoisted(() => ({ sessionIds: [] as string[] }));
vi.mock('@/lib/worker-jobs', () => ({
  enqueueEnsureSessionBuffer: async (_db: unknown, sessionId: string) => {
    kicks.sessionIds.push(sessionId);
  },
}));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));

const { POST } = await import('@/app/api/sessions/loop-lease/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/sessions/loop-lease', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('loop-lease-route-test');
  holder.db = testDb.db;
});
afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});
beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, [...GENERATION_FIXTURE_TABLES, 'session_loop_leases']);
  holder.ownerUserId = null;
  kicks.sessionIds = [];
});

describe.skipIf(skip)('POST /api/sessions/loop-lease', () => {
  it('acquire → renew → release round-trips acknowledged states', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId });
    const base = { sessionId, clientId: 'tab-a' };

    const acquired = loopLeaseResponseSchema.parse(
      await (await post({ ...base, epoch: 1, action: 'acquire' })).json(),
    );
    if (!acquired.ok) throw new Error('unreachable');
    expect(acquired.data).toMatchObject({
      applied: true,
      held: true,
      lease: { epoch: 1, released: false },
    });

    const renewed = loopLeaseResponseSchema.parse(
      await (await post({ ...base, epoch: 2, action: 'renew' })).json(),
    );
    if (!renewed.ok) throw new Error('unreachable');
    expect(renewed.data).toMatchObject({ applied: true, held: true, lease: { epoch: 2 } });

    const released = loopLeaseResponseSchema.parse(
      await (await post({ ...base, epoch: 3, action: 'release' })).json(),
    );
    if (!released.ok) throw new Error('unreachable');
    expect(released.data).toMatchObject({
      applied: true,
      held: false,
      lease: { epoch: 3, released: true },
    });
  });

  it('kicks the buffer only when a release ends the hold', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId });

    await post({ sessionId, clientId: 'tab-a', epoch: 1, action: 'acquire' });
    await post({ sessionId, clientId: 'tab-b', epoch: 1, action: 'acquire' });
    await post({ sessionId, clientId: 'tab-a', epoch: 2, action: 'release' });
    expect(kicks.sessionIds).toEqual([]);

    await post({ sessionId, clientId: 'tab-b', epoch: 2, action: 'release' });
    expect(kicks.sessionIds).toEqual([sessionId]);
  });

  it('acknowledges every operation with the real current state (foreign hold survives)', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId });
    await post({ sessionId, clientId: 'tab-a', epoch: 5, action: 'acquire' });

    // Tab B owns no lease — its release records its OWN tombstone (reordering
    // safety for its delayed acquire), and the acknowledged state still tells
    // it the SESSION is held (by another tab, untouched).
    const foreignRelease = loopLeaseResponseSchema.parse(
      await (await post({ sessionId, clientId: 'tab-b', epoch: 99, action: 'release' })).json(),
    );
    if (!foreignRelease.ok) throw new Error('unreachable');
    expect(foreignRelease.data).toMatchObject({
      applied: true,
      held: true,
      lease: { epoch: 99, released: true },
    });

    // A STALE later operation is rejected but still learns the real state.
    const stale = loopLeaseResponseSchema.parse(
      await (await post({ sessionId, clientId: 'tab-b', epoch: 98, action: 'acquire' })).json(),
    );
    if (!stale.ok) throw new Error('unreachable');
    expect(stale.data).toMatchObject({ applied: false, held: true });
  });

  it('an unowned session answers not_found (IDOR posture)', async () => {
    const other = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId: other });
    holder.ownerUserId = await createUser(testDb.db);

    const res = await post({ sessionId, clientId: 'tab-a', epoch: 1, action: 'acquire' });
    expect(res.status).toBe(404);
  });

  it('rejects a malformed body (unknown action, missing epoch) with 400', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId });

    expect((await post({ sessionId, clientId: 'a', epoch: 1, action: 'toggle' })).status).toBe(400);
    expect((await post({ sessionId, clientId: 'a', action: 'acquire' })).status).toBe(400);
  });

  it('requires the admin session (401 unauthenticated)', async () => {
    const res = await post({
      sessionId: '00000000-0000-4000-8000-000000000000',
      clientId: 'tab-a',
      epoch: 1,
      action: 'acquire',
    });
    expect(res.status).toBe(401);
  });
});
