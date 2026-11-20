import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { localFsStorageProvider, type StorageProvider } from '@liedmotif/storage';
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

// Favorites is shareable like any curated playlist: the owner places it In
// Lounge over the share route, a Visitor finds it in their Lounge under its
// fixed name, opens it, and plays what the owner starred.

const holder = vi.hoisted(() => ({
  db: null as unknown,
  storage: null as unknown,
  userId: null as string | null,
}));

vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/providers/providers', () => ({ getStorageProvider: () => holder.storage }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.userId ? { user: { id: holder.userId } } : null),
  getAppSession: async () => (holder.userId ? { user: { id: holder.userId } } : null),
}));

const { POST: sharePost } = await import('@/app/api/playlists/share/route');
const { POST: favoritePost } = await import('@/app/api/tracks/favorite/route');
const { GET: loungeGet } = await import('@/app/api/lounge/route');
const { GET: loungePlaylistGet } = await import('@/app/api/lounge/playlist/route');
const { GET: getAudio } = await import('@/app/api/audio/[trackId]/route');

const skip = !TEST_DATABASE_URL;
const AUDIO_BYTES = Buffer.from('starred-audio-bytes');

let testDb: TestDb;
let dataRoot: string;
let storage: StorageProvider;

function postJson(handler: (r: Request) => Promise<Response>, body: unknown) {
  return handler(
    new Request('http://localhost/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function seedPlayableTrack(ownerUserId: string): Promise<string> {
  const audioKey = `tracks/${ownerUserId}/starred/original.mp3`;
  await storage.write({ key: audioKey, body: AUDIO_BYTES, mimeType: 'audio/mpeg' });
  const sessionId = await createSession(testDb.db, { ownerUserId });
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  return createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId: jobId,
    audioStorageKey: audioKey,
    audioMimeType: 'audio/mpeg',
  });
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('shared-favorites-reaches-a-visitor-test');
  dataRoot = await mkdtemp(path.join(tmpdir(), 'liedmotif-shared-favorites-'));
  storage = localFsStorageProvider({ dataRoot });
  holder.db = testDb.db;
  holder.storage = storage;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
  await rm(dataRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, ['playlist_tracks', 'playlists', ...GENERATION_FIXTURE_TABLES]);
  holder.userId = null;
});

afterEach(() => {
  holder.userId = null;
});

describe.skipIf(skip)('a shared Favorites', () => {
  it('reaches a Visitor’s Lounge under its fixed name and plays the starred track', async () => {
    const ownerUserId = await createUser(testDb.db);
    const trackId = await seedPlayableTrack(ownerUserId);
    holder.userId = ownerUserId;
    expect((await postJson(favoritePost, { trackId, favorited: true })).status).toBe(200);
    const favorites = await testDb.pool.query(
      "select id from playlists where owner_user_id = $1 and kind = 'favorites'",
      [ownerUserId],
    );
    const favoritesId = favorites.rows[0].id as string;

    const shared = await postJson(sharePost, {
      playlistId: favoritesId,
      audience: { kind: 'everyone' },
    });
    expect(shared.status).toBe(200);

    holder.userId = await createUser(testDb.db);
    const lounge = await loungeGet(new Request('http://localhost/api/lounge'));
    const loungePayload = (await lounge.json()) as {
      data: { playlists: Array<{ id: string; name: string; trackCount: number }> };
    };
    expect(loungePayload.data.playlists).toMatchObject([
      { id: favoritesId, name: 'Favorites', trackCount: 1 },
    ]);

    const detail = await loungePlaylistGet(
      new Request(`http://localhost/api/lounge/playlist?playlistId=${favoritesId}`),
    );
    expect(detail.status).toBe(200);
    const detailPayload = (await detail.json()) as { data: { items: Array<{ id: string }> } };
    expect(detailPayload.data.items.map((item) => item.id)).toEqual([trackId]);

    const audio = await getAudio(new Request(`http://localhost/api/audio/${trackId}`), {
      params: Promise.resolve({ trackId }),
    });
    expect(audio.status).toBe(200);
    expect(Buffer.from(await audio.arrayBuffer()).equals(AUDIO_BYTES)).toBe(true);
  });
});
