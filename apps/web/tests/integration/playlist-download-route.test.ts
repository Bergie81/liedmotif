import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { embedId3Tags } from '@liedmotif/shared';
import { localFsStorageProvider, shortId, type StorageProvider } from '@liedmotif/storage';
import { addPlaylistTracks, createPlaylist, ensureFavoritesPlaylist } from '@liedmotif/db';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// Playlist zip download route: streams <name-slug>-<id8>.zip with the
// playlist's downloadable members in position order. Stream-only
// members are skipped; empty/foreign playlists are a uniform 404.

const holder = vi.hoisted(() => ({
  db: null as unknown,
  storage: null as unknown,
  ownerUserId: null as string | null,
}));

const enqueueEmbedTrackMetadataBatch = vi.hoisted(() =>
  vi.fn(async (_db: unknown, _trackIds: string[]) => undefined),
);

vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/providers', () => ({ getStorageProvider: () => holder.storage }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
vi.mock('@/lib/worker-jobs', () => ({ enqueueEmbedTrackMetadataBatch }));

const { GET } = await import('@/app/api/playlists/[playlistId]/download/route');

const skip = !TEST_DATABASE_URL;
const TABLES = ['playlist_tracks', 'playlists', ...GENERATION_FIXTURE_TABLES] as const;
let testDb: TestDb;
let dataRoot: string;
let storage: StorageProvider;

const TAGGED_BODY = Buffer.from(
  embedId3Tags(new Uint8Array([5, 6, 7, 8]), { userText: { Liedmotif: 'v3:test' } }),
);

let keyCounter = 0;
async function seedTrack(
  ownerUserId: string,
  fx: { title?: string | null; streamOnly?: boolean } = {},
): Promise<string> {
  keyCounter += 1;
  const requestId = await createGenerationRequest(testDb.db, { ownerUserId });
  const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  const key = `tracks/${ownerUserId}/p/original-${keyCounter}.mp3`;
  if (!fx.streamOnly) {
    await storage.write({ key, body: TAGGED_BODY, mimeType: 'audio/mpeg' });
  }
  return createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId: jobId,
    title: fx.title ?? null,
    ...(fx.streamOnly
      ? { status: 'streamable' as const, streamEncryptedSourceUrl: 'enc:stream' }
      : { audioStorageKey: key, audioMimeType: 'audio/mpeg' }),
  });
}

function get(playlistId: string): Promise<Response> {
  return GET(new Request(`http://test.local/api/playlists/${playlistId}/download`), {
    params: Promise.resolve({ playlistId }),
  });
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('playlist-download-route-test');
  dataRoot = await mkdtemp(path.join(tmpdir(), 'liedmotif-playlist-zip-'));
  storage = localFsStorageProvider({ dataRoot });
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
  await rm(dataRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, TABLES);
  holder.db = testDb.db;
  holder.storage = storage;
  holder.ownerUserId = null;
  enqueueEmbedTrackMetadataBatch.mockClear();
});

describe.skipIf(skip)('GET /api/playlists/[playlistId]/download', () => {
  it('streams the members in position order, named after the playlist', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const trackB = await seedTrack(ownerUserId, { title: 'Beta' });
    const trackA = await seedTrack(ownerUserId, { title: 'Alpha' });
    const streamOnly = await seedTrack(ownerUserId, { streamOnly: true });
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Road Trip!' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackIds: [trackB, streamOnly, trackA],
    });

    const response = await get(playlist.id);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    const playlistId8 = shortId(playlist.id);
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="road-trip-${playlistId8}.zip"`,
    );

    const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
    const bId8 = shortId(trackB);
    const aId8 = shortId(trackA);
    expect(zip.getEntries().map((entry) => entry.entryName)).toEqual([
      `001-beta-${bId8}.mp3`,
      `002-alpha-${aId8}.mp3`,
    ]);
  });

  it('downloads the Favorites system playlist and falls back to playlist-<id8> for empty slugs', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const track = await seedTrack(ownerUserId, { title: 'Solo' });
    const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: favorites.id,
      trackIds: [track],
    });
    const favoritesId8 = shortId(favorites.id);
    const favoritesResponse = await get(favorites.id);
    expect(favoritesResponse.status).toBe(200);
    expect(favoritesResponse.headers.get('content-disposition')).toBe(
      `attachment; filename="favorites-${favoritesId8}.zip"`,
    );
    await favoritesResponse.body?.cancel();

    const emoji = await createPlaylist(testDb.db, { ownerUserId, name: '🎵🎵' });
    await addPlaylistTracks(testDb.db, { ownerUserId, playlistId: emoji.id, trackIds: [track] });
    const emojiId8 = shortId(emoji.id);
    const emojiResponse = await get(emoji.id);
    expect(emojiResponse.headers.get('content-disposition')).toBe(
      `attachment; filename="playlist-${emojiId8}.zip"`,
    );
    await emojiResponse.body?.cancel();
  });

  it('404s an empty playlist, a foreign playlist, and a malformed id', async () => {
    const ownerUserId = await createUser(testDb.db);
    const otherUserId = await createUser(testDb.db);
    const streamOnly = await seedTrack(ownerUserId, { streamOnly: true });
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Sparse' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackIds: [streamOnly],
    });

    expect((await get(playlist.id)).status).toBe(401);

    holder.ownerUserId = ownerUserId;
    expect((await get(playlist.id)).status).toBe(404);
    expect((await get('not-a-uuid')).status).toBe(404);

    holder.ownerUserId = otherUserId;
    expect((await get(playlist.id)).status).toBe(404);
  });
});
