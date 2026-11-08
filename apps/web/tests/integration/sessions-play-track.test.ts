import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createQueueItem,
  createSession,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// POST /api/sessions/play-track: play one of a session's own Tracks through
// the session — resume-if-stopped (superseding the active session) plus
// queue-cursor positioning; an Active session only moves its cursor. Owner
// scoped; a foreign Track reads as not found.

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
vi.mock('@/lib/worker-jobs', () => ({ enqueueEnsureSessionBuffer: vi.fn(async () => {}) }));

const { POST: playTrackPost } = await import('@/app/api/sessions/play-track/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function postJson(body: unknown) {
  return playTrackPost(
    new Request('http://localhost/api/sessions/play-track', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function seedSessionTrack(
  ownerUserId: string,
  status: 'active' | 'stopped',
): Promise<{ sessionId: string; trackId: string; queueItemId: string }> {
  const sessionId = await createSession(testDb.db, { ownerUserId, status });
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const providerJobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  const trackId = await createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId,
    audioStorageKey: 'test/track.mp3',
  });
  const queueItemId = await createQueueItem(testDb.db, {
    activitySessionId: sessionId,
    trackId,
    generationRequestId: requestId,
    position: 0,
    state: 'played',
  });
  return { sessionId, trackId, queueItemId };
}

async function readCursor(sessionId: string) {
  const { rows } = await testDb.pool.query(
    'select status, current_queue_item_id, current_track_id from activity_sessions where id = $1',
    [sessionId],
  );
  return rows[0] as {
    status: string;
    current_queue_item_id: string | null;
    current_track_id: string | null;
  };
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('sessions-play-track-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, [...GENERATION_FIXTURE_TABLES, 'app_settings']);
  holder.ownerUserId = null;
});

describe.skipIf(skip)('POST /api/sessions/play-track', () => {
  it('resumes a stopped session positioned at the track and supersedes the active one', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const activeId = await createSession(testDb.db, { ownerUserId: owner, status: 'active' });
    const { sessionId, trackId, queueItemId } = await seedSessionTrack(owner, 'stopped');

    const body = await (await postJson({ sessionId, trackId, clientId: 'phone-1' })).json();
    expect(body.ok).toBe(true);
    expect(body.data.session.id).toBe(sessionId);
    expect(body.data.session.status).toBe('active');
    expect(body.data.supersededSessionId).toBe(activeId);

    const cursor = await readCursor(sessionId);
    expect(cursor.status).toBe('active');
    expect(cursor.current_queue_item_id).toBe(queueItemId);
    expect(cursor.current_track_id).toBe(trackId);
  });

  it('moves only the cursor of the active session', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const { sessionId, trackId, queueItemId } = await seedSessionTrack(owner, 'active');

    const body = await (await postJson({ sessionId, trackId, clientId: 'phone-1' })).json();
    expect(body.ok).toBe(true);
    expect(body.data.supersededSessionId).toBeNull();
    expect((await readCursor(sessionId)).current_queue_item_id).toBe(queueItemId);
  });

  it.each(['missing_audio', 'rejected', 'disliked', 'deleted', 'pending'])(
    'rejects %s before changing either Session',
    async (reason) => {
      const owner = await createUser(testDb.db);
      holder.ownerUserId = owner;
      const activeId = await createSession(testDb.db, { ownerUserId: owner, status: 'active' });
      const target = await seedSessionTrack(owner, 'stopped');
      if (reason === 'missing_audio') {
        await testDb.pool.query('delete from track_audio_assets where track_id = $1', [
          target.trackId,
        ]);
      } else if (reason === 'disliked') {
        await testDb.pool.query('update tracks set disliked_at = now() where id = $1', [
          target.trackId,
        ]);
      } else {
        await testDb.pool.query('update tracks set status = $1 where id = $2', [
          reason,
          target.trackId,
        ]);
      }
      const response = await postJson({
        sessionId: target.sessionId,
        trackId: target.trackId,
        clientId: 'phone-1',
      });
      expect(response.status).toBe(404);
      expect((await readCursor(activeId)).status).toBe('active');
      expect(await readCursor(target.sessionId)).toMatchObject({
        status: 'stopped',
        current_track_id: null,
        current_queue_item_id: null,
      });
    },
  );

  it('creates a Queue slot only when explicitly selecting a playable historical sibling', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const { sessionId, trackId, queueItemId } = await seedSessionTrack(owner, 'stopped');
    await testDb.pool.query('delete from activity_session_queue_items where id = $1', [
      queueItemId,
    ]);
    const body = await (await postJson({ sessionId, trackId, clientId: 'phone-1' })).json();
    expect(body.ok).toBe(true);
    expect(await readCursor(sessionId)).toMatchObject({
      status: 'active',
      current_track_id: trackId,
      current_queue_item_id: expect.any(String),
    });
    await postJson({ sessionId, trackId, clientId: 'phone-1' });
    const slots = await testDb.pool.query(
      'select id from activity_session_queue_items where activity_session_id = $1 and track_id = $2',
      [sessionId, trackId],
    );
    expect(slots.rows).toHaveLength(1);
  });

  it('rejects a track belonging to another session, and foreign sessions', async () => {
    const owner = await createUser(testDb.db);
    const other = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const mine = await seedSessionTrack(owner, 'active');
    const stranger = await seedSessionTrack(other, 'stopped');

    const slotless = await postJson({
      sessionId: mine.sessionId,
      trackId: stranger.trackId,
      clientId: 'phone-1',
    });
    expect(slotless.status).toBe(404);

    const foreign = await postJson({
      sessionId: stranger.sessionId,
      trackId: stranger.trackId,
      clientId: 'phone-1',
    });
    expect(foreign.status).toBe(404);
    expect((await readCursor(stranger.sessionId)).status).toBe('stopped');
  });
});
