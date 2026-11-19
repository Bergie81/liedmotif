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

const holder = vi.hoisted(() => ({
  db: null as unknown,
  ownerUserId: null as string | null,
  retagged: [] as string[],
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
vi.mock('@/lib/worker-jobs', () => ({
  enqueueEmbedTrackMetadataBatch: async (_db: unknown, trackIds: string[]) => {
    holder.retagged.push(...trackIds);
  },
}));

const { POST: renamePost } = await import('@/app/api/sessions/rename/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function postRename(body: unknown) {
  return renamePost(
    new Request('http://localhost/api/sessions/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** A session with one downloaded (final MP3) track and one stream-only track. */
async function seedSession(ownerUserId: string, title = 'Derived Name') {
  const sessionId = await createSession(testDb.db, { ownerUserId, title });
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const providerJobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  const downloadedTrackId = await createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId,
    audioStorageKey: `rename/${ownerUserId}/downloaded.mp3`,
  });
  const streamOnlyTrackId = await createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId,
  });
  return { sessionId, downloadedTrackId, streamOnlyTrackId };
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('session-rename-route-test');
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
  holder.retagged = [];
});

describe.skipIf(skip)('POST /api/sessions/rename', () => {
  it('renames an owned session and retags only its downloaded tracks', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const { sessionId, downloadedTrackId } = await seedSession(ownerUserId);

    const response = await postRename({ sessionId, title: '  Late Night Focus  ' });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.session.id).toBe(sessionId);
    expect(body.data.session.title).toBe('Late Night Focus');
    const row = await testDb.pool.query('select title from activity_sessions where id = $1', [
      sessionId,
    ]);
    expect(row.rows[0].title).toBe('Late Night Focus');
    expect(holder.retagged).toEqual([downloadedTrackId]);
  });

  it('rejects a blank name as a validation error', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const { sessionId } = await seedSession(ownerUserId);

    const response = await postRename({ sessionId, title: '   ' });

    expect(response.status).toBe(400);
    const row = await testDb.pool.query('select title from activity_sessions where id = $1', [
      sessionId,
    ]);
    expect(row.rows[0].title).toBe('Derived Name');
    expect(holder.retagged).toEqual([]);
  });

  it('rejects a name over 60 characters', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const { sessionId } = await seedSession(ownerUserId);

    const response = await postRename({ sessionId, title: 'x'.repeat(61) });

    expect(response.status).toBe(400);
    expect((await postRename({ sessionId, title: 'x'.repeat(60) })).status).toBe(200);
  });

  it('returns 404 for an unknown or cross-owner session', async () => {
    const ownerUserId = await createUser(testDb.db);
    const { sessionId } = await seedSession(ownerUserId);
    holder.ownerUserId = await createUser(testDb.db);

    expect((await postRename({ sessionId, title: 'Mine Now' })).status).toBe(404);
    expect(
      (await postRename({ sessionId: '00000000-0000-4000-8000-000000000000', title: 'Ghost' }))
        .status,
    ).toBe(404);
    const row = await testDb.pool.query('select title from activity_sessions where id = $1', [
      sessionId,
    ]);
    expect(row.rows[0].title).toBe('Derived Name');
    expect(holder.retagged).toEqual([]);
  });
});
