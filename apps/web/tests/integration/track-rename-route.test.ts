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

const { POST: renamePost } = await import('@/app/api/tracks/rename/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function postRename(body: unknown) {
  return renamePost(
    new Request('http://localhost/api/tracks/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** Two sibling tracks from one provider job; only the first has a final MP3. */
async function seedTracks(ownerUserId: string) {
  const sessionId = await createSession(testDb.db, { ownerUserId });
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const providerJobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  const downloadedTrackId = await createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId,
    title: 'Focus 1',
    audioStorageKey: `rename/${ownerUserId}/downloaded.mp3`,
  });
  const siblingTrackId = await createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId,
    title: 'Focus 2',
  });
  return { downloadedTrackId, siblingTrackId };
}

async function titleOf(trackId: string): Promise<string | null> {
  const row = await testDb.pool.query('select title from tracks where id = $1', [trackId]);
  return row.rows[0].title;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('track-rename-route-test');
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

describe.skipIf(skip)('POST /api/tracks/rename', () => {
  it('renames an owned downloaded track and retags it, leaving the sibling untouched', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const { downloadedTrackId, siblingTrackId } = await seedTracks(ownerUserId);

    const response = await postRename({ trackId: downloadedTrackId, title: '  Midnight Run  ' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: { trackId: downloadedTrackId, title: 'Midnight Run' },
    });
    expect(await titleOf(downloadedTrackId)).toBe('Midnight Run');
    expect(await titleOf(siblingTrackId)).toBe('Focus 2');
    expect(holder.retagged).toEqual([downloadedTrackId]);
  });

  it('renames a stream-only track; the unconditional retag enqueue is a server-side no-op', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const { siblingTrackId } = await seedTracks(ownerUserId);

    const response = await postRename({ trackId: siblingTrackId, title: 'Stream Only' });

    expect(response.status).toBe(200);
    expect(await titleOf(siblingTrackId)).toBe('Stream Only');
    // The embed job itself skips tracks without a local MP3 (lyrics-route
    // precedent), so the route enqueues without checking for one.
    expect(holder.retagged).toEqual([siblingTrackId]);
  });

  it('rejects a blank name and a name over 80 characters', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const { downloadedTrackId } = await seedTracks(ownerUserId);

    expect((await postRename({ trackId: downloadedTrackId, title: '   ' })).status).toBe(400);
    expect((await postRename({ trackId: downloadedTrackId, title: 'x'.repeat(81) })).status).toBe(
      400,
    );
    expect((await postRename({ trackId: downloadedTrackId, title: 'x'.repeat(80) })).status).toBe(
      200,
    );
  });

  // One representative mutation route, proving the shared guard's Origin check
  // is actually reached from a handler — the wiring the other ~85 share.
  it('refuses a cross-site POST before it writes anything', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const { downloadedTrackId } = await seedTracks(ownerUserId);

    const response = await renamePost(
      new Request('http://localhost/api/tracks/rename', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ trackId: downloadedTrackId, title: 'Owned By Someone Else' }),
      }),
    );

    expect(response.status).toBe(403);
    expect(await titleOf(downloadedTrackId)).toBe('Focus 1');
  });

  it('returns 404 for an unknown or cross-owner track', async () => {
    const ownerUserId = await createUser(testDb.db);
    const { downloadedTrackId } = await seedTracks(ownerUserId);
    holder.ownerUserId = await createUser(testDb.db);

    expect((await postRename({ trackId: downloadedTrackId, title: 'Mine Now' })).status).toBe(404);
    expect(
      (await postRename({ trackId: '00000000-0000-4000-8000-000000000000', title: 'Ghost' }))
        .status,
    ).toBe(404);
    expect(await titleOf(downloadedTrackId)).toBe('Focus 1');
    expect(holder.retagged).toEqual([]);
  });
});
