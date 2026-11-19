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

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));

const { POST: deletePost } = await import('@/app/api/tracks/delete/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function postDelete(trackId: string) {
  return deletePost(
    new Request('http://localhost/api/tracks/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trackId }),
    }),
  );
}

async function seedTrack(ownerUserId: string) {
  const sessionId = await createSession(testDb.db, { ownerUserId });
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const providerJobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  const retainedAt = new Date('2026-07-20T12:00:00.000Z');
  const trackId = await createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId,
    audioStorageKey: `delete/${ownerUserId}/track.mp3`,
    savedAt: retainedAt,
    favoritedAt: retainedAt,
  });
  const queueItemId = await createQueueItem(testDb.db, {
    activitySessionId: sessionId,
    trackId,
    position: 0,
    state: 'playing',
  });
  return { trackId, queueItemId };
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('track-delete-route-test');
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

describe.skipIf(skip)('POST /api/tracks/delete', () => {
  it('deletes an owned retained track without recording feedback', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const { trackId, queueItemId } = await seedTrack(ownerUserId);
    const before = Date.now();

    const response = await postDelete(trackId);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { trackId, deleted: true } });
    const track = await testDb.pool.query(
      'select status, saved_at, favorited_at, disliked_at from tracks where id = $1',
      [trackId],
    );
    expect(track.rows[0]).toMatchObject({
      status: 'deleted',
      disliked_at: null,
    });
    // Retention is membership: a deleted track leaves every retention surface
    // (flags cleared, memberships purged) — not feedback, so dislikedAt stays null.
    expect(track.rows[0].saved_at).toBeNull();
    expect(track.rows[0].favorited_at).toBeNull();
    expect(
      Number(
        (
          await testDb.pool.query('select count(*) from playlist_tracks where track_id = $1', [
            trackId,
          ])
        ).rows[0].count,
      ),
    ).toBe(0);
    const queueItem = await testDb.pool.query(
      'select state from activity_session_queue_items where id = $1',
      [queueItemId],
    );
    expect(queueItem.rows[0].state).toBe('rejected');
    expect(
      Number(
        (
          await testDb.pool.query('select count(*) from track_audio_assets where track_id = $1', [
            trackId,
          ])
        ).rows[0].count,
      ),
    ).toBe(0);
    const deletion = await testDb.pool.query(
      'select reason, delete_after from deletion_queue_items where track_id = $1',
      [trackId],
    );
    expect(deletion.rows).toHaveLength(1);
    expect(deletion.rows[0].reason).toBe('user_delete');
    expect(new Date(deletion.rows[0].delete_after).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(deletion.rows[0].delete_after).getTime()).toBeLessThanOrEqual(Date.now());
    expect(
      Number(
        (
          await testDb.pool.query('select count(*) from feedback_events where track_id = $1', [
            trackId,
          ])
        ).rows[0].count,
      ),
    ).toBe(0);
  });

  it('is idempotent after deletion', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const { trackId } = await seedTrack(ownerUserId);

    expect((await postDelete(trackId)).status).toBe(200);
    expect((await postDelete(trackId)).status).toBe(200);
    const queued = await testDb.pool.query(
      'select count(*) from deletion_queue_items where track_id = $1',
      [trackId],
    );
    expect(Number(queued.rows[0].count)).toBe(1);
  });

  it('treats an already rejected owned track as a no-op success', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const { trackId } = await seedTrack(ownerUserId);
    await testDb.pool.query("update tracks set status = 'rejected' where id = $1", [trackId]);

    const response = await postDelete(trackId);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { trackId, deleted: true } });
    const queued = await testDb.pool.query(
      'select count(*) from deletion_queue_items where track_id = $1',
      [trackId],
    );
    expect(Number(queued.rows[0].count)).toBe(0);
  });

  it('returns 404 for an unknown or cross-owner track', async () => {
    const ownerUserId = await createUser(testDb.db);
    const { trackId } = await seedTrack(ownerUserId);
    holder.ownerUserId = await createUser(testDb.db);

    expect((await postDelete(trackId)).status).toBe(404);
    expect((await postDelete('00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});
