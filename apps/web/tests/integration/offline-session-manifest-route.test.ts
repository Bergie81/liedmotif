import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { activitySessions, deleteSession, rejectDislikedTrack } from '@liedmotif/db';
import {
  connectTestDb,
  createCoverImage,
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
import { getOfflineManifestResponseSchema, type OfflineManifest } from '@liedmotif/shared';

// The offline manifest for one marked Session: the owner's Tracks the device
// may store (Download's eligibility — a ready, un-Disliked Track with a
// servable local final, Ephemeral ones included), in play order, each with its
// byte size and metadata version. Foreign, absent, deleted and malformed ids
// are one uniform 404, like the audio route.

const holder = vi.hoisted(() => ({
  db: null as unknown,
  ownerUserId: null as string | null,
}));

vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));

const { GET } = await import('@/app/api/offline/sessions/[sessionId]/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('offline-session-manifest-route-test');
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, GENERATION_FIXTURE_TABLES);
  holder.db = testDb.db;
  holder.ownerUserId = null;
});

let keyCounter = 0;
async function seedTrack(
  ownerUserId: string,
  sessionId: string,
  fx: { title?: string; streamOnly?: boolean; byteSize?: number; queuePosition?: number } = {},
): Promise<string> {
  keyCounter += 1;
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  const trackId = await createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId: jobId,
    title: fx.title ?? null,
    durationSeconds: 120,
    genreTags: ['ambient'],
    ...(fx.streamOnly
      ? { status: 'streamable' as const, streamEncryptedSourceUrl: 'enc:stream' }
      : {
          audioStorageKey: `tracks/${ownerUserId}/offline-session/${keyCounter}.mp3`,
          audioByteSize: fx.byteSize ?? 4_000_000,
        }),
  });
  if (fx.queuePosition !== undefined) {
    await createQueueItem(testDb.db, {
      activitySessionId: sessionId,
      trackId,
      generationRequestId: requestId,
      position: fx.queuePosition,
    });
  }
  return trackId;
}

async function get(sessionId: string): Promise<Response> {
  return GET(new Request(`http://test.local/api/offline/sessions/${sessionId}`), {
    params: Promise.resolve({ sessionId }),
  });
}

async function manifest(sessionId: string): Promise<OfflineManifest> {
  const response = await get(sessionId);
  expect(response.status).toBe(200);
  const parsed = getOfflineManifestResponseSchema.parse(await response.json());
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.data;
}

describe.skipIf(skip)('GET /api/offline/sessions/[sessionId]', () => {
  it('counts the Tracks it cannot list, but not the Disliked ones the Session no longer shows', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId });
    const kept = await seedTrack(ownerUserId, sessionId, { queuePosition: 1 });
    await seedTrack(ownerUserId, sessionId, { streamOnly: true, queuePosition: 2 });
    const disliked = await seedTrack(ownerUserId, sessionId, { queuePosition: 3 });
    await rejectDislikedTrack(testDb.db, { ownerUserId, trackId: disliked });

    const result = await manifest(sessionId);

    expect(result.tracks.map((track) => track.trackId)).toEqual([kept]);
    expect(result.leftOutTrackCount).toBe(1);
  });

  it('lists the storable Tracks in play order, never-enqueued siblings last, with the Session as name', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const cover = await createCoverImage(testDb.db);
    const sessionId = await createSession(testDb.db, {
      ownerUserId,
      title: 'Deep Focus',
      coverImageId: cover,
    });
    const sibling = await seedTrack(ownerUserId, sessionId, { title: 'Sibling' });
    const second = await seedTrack(ownerUserId, sessionId, { title: 'Second', queuePosition: 2 });
    const first = await seedTrack(ownerUserId, sessionId, {
      title: 'First',
      queuePosition: 1,
      byteSize: 5_000_000,
    });

    const result = await manifest(sessionId);

    expect(result.name).toBe('Deep Focus');
    expect(result.tracks.map((track) => track.trackId)).toEqual([first, second, sibling]);
    expect(result.tracks[0]).toMatchObject({
      trackId: first,
      byteSize: 5_000_000,
      title: 'First',
      originSessionTitle: 'Deep Focus',
      coverImageId: cover,
      genreTags: ['ambient'],
      fromLounge: false,
    });
  });

  it('never lists stream-only or Disliked Tracks — the same Tracks Download takes', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId });
    const kept = await seedTrack(ownerUserId, sessionId, { queuePosition: 1 });
    await seedTrack(ownerUserId, sessionId, { streamOnly: true, queuePosition: 2 });
    const disliked = await seedTrack(ownerUserId, sessionId, { queuePosition: 3 });
    await rejectDislikedTrack(testDb.db, { ownerUserId, trackId: disliked });

    expect((await manifest(sessionId)).tracks.map((track) => track.trackId)).toEqual([kept]);
  });

  it('answers a Session with nothing stored yet with no Tracks rather than a 404', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId });

    expect(await manifest(sessionId)).toEqual({
      name: 'Untitled Session',
      tracks: [],
      leftOutTrackCount: 0,
    });
  });

  it('is one uniform 404 for a foreign, deleted, delete-pending, absent or malformed Session, and 401 signed out', async () => {
    const ownerUserId = await createUser(testDb.db);
    const otherUserId = await createUser(testDb.db);
    const mine = await createSession(testDb.db, { ownerUserId });
    await seedTrack(ownerUserId, mine, { queuePosition: 1 });

    expect((await get(mine)).status).toBe(401);

    holder.ownerUserId = otherUserId;
    expect((await get(mine)).status).toBe(404);
    expect((await get('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await get('not-a-uuid')).status).toBe(404);

    holder.ownerUserId = ownerUserId;
    const deleted = await createSession(testDb.db, { ownerUserId, status: 'stopped' });
    await seedTrack(ownerUserId, deleted, { queuePosition: 1 });
    expect(await deleteSession(testDb.db, { ownerUserId, sessionId: deleted })).toMatchObject({
      ok: true,
      deferred: false,
    });
    expect((await get(deleted)).status).toBe(404);

    await testDb.db
      .update(activitySessions)
      .set({ deleteRequestedAt: new Date() })
      .where(eq(activitySessions.id, mine));
    expect((await get(mine)).status).toBe(404);
  });
});
