import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { localFsStorageProvider, type StorageProvider } from '@liedmotif/storage';
import {
  addPlaylistTracks,
  coverImages,
  createPlaylist,
  deleteTrack,
  removePlaylistTrack,
  setPlaylistShared,
  usageEvents,
} from '@liedmotif/db';
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

// The Lounge security floor: cross-owner reads (audio, cover, lyrics, Track
// Data) answer 200 exactly while the track is Lounge-audible — in >= 1
// In-Lounge playlist OF ITS OWNER — and a uniform 404 the moment that stops
// holding (unshare, removal from the last sharing playlist, track delete).
// Downloads never widen. Unknown, unowned-and-unshared, and revoked ids must
// be indistinguishable on every route.

const holder = vi.hoisted(() => ({
  db: null as unknown,
  storage: null as unknown,
  viewerUserId: null as string | null,
  musicProviderCalls: 0,
}));

vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/providers/providers', () => ({
  getStorageProvider: () => holder.storage,
  // A provider whose every use is counted: a visitor reaches it only for word timing.
  getMusicProvider: () => {
    holder.musicProviderCalls += 1;
    return {
      providerKey: 'mock',
      getGenerationStatus: async () => ({ tracks: [] }),
      getTimestampedLyrics: async () => ({
        words: [
          { word: 'la la lounge\n', startSeconds: 6.1, endSeconds: 8.2, success: true },
          { word: 'keep it low\n', startSeconds: 9, endSeconds: 11, success: true },
        ],
        alignmentErrorScore: 0.05,
      }),
    };
  },
}));
vi.mock('@/lib/worker-jobs', () => ({
  enqueueEmbedTrackMetadataBatch: async () => undefined,
}));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.viewerUserId ? { user: { id: holder.viewerUserId } } : null),
  getAppSession: async () => (holder.viewerUserId ? { user: { id: holder.viewerUserId } } : null),
}));

const { GET: getAudio } = await import('@/app/api/audio/[trackId]/route');
const { GET: getCover } = await import('@/app/api/covers/[id]/route');
const { GET: getDetails } = await import('@/app/api/tracks/[trackId]/details/route');
const { GET: getLyrics } = await import('@/app/api/tracks/[trackId]/lyrics/route');
const { GET: getTrackDownload } = await import('@/app/api/tracks/[trackId]/download/route');
const { GET: getPlaylistDownload } =
  await import('@/app/api/playlists/[playlistId]/download/route');

const skip = !TEST_DATABASE_URL;
const AUDIO_BYTES = Buffer.from('lounge-audible-audio-bytes');
const COVER_BYTES = Buffer.from('lounge-cover-bytes');
const FIXTURE_TABLES = [...GENERATION_FIXTURE_TABLES, 'cover_images'] as const;

let testDb: TestDb;
let dataRoot: string;
let storage: StorageProvider;

let seedCounter = 0;

/** An owner's ready track (audio downloaded) with a session cover, filed into
 *  one playlist of the owner's, which is In Lounge. The Lounge-audible base
 *  fixture every case revokes differently. */
async function seedSharedTrack(opts: { vocal?: boolean; lyrics?: string | null } = {}) {
  seedCounter += 1;
  const ownerUserId = await createUser(testDb.db);
  const audioKey = `tracks/${ownerUserId}/lounge-${seedCounter}/original.mp3`;
  await storage.write({ key: audioKey, body: AUDIO_BYTES, mimeType: 'audio/mpeg' });

  const coverKey = `covers/${ownerUserId}/lounge-${seedCounter}.webp`;
  await storage.write({ key: coverKey, body: COVER_BYTES, mimeType: 'image/webp' });
  const [cover] = await testDb.db
    .insert(coverImages)
    .values({
      sourceType: 'generated',
      storageProvider: 'local-fs',
      storageKey: coverKey,
      provenance: { ownerUserId },
    })
    .returning({ id: coverImages.id });
  const coverImageId = cover!.id;

  const sessionId = await createSession(testDb.db, { ownerUserId, coverImageId });
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  const trackId = await createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId: jobId,
    audioStorageKey: audioKey,
    audioMimeType: 'audio/mpeg',
    ...(opts.vocal ? { vocalMode: 'vocal' as const } : {}),
    ...(opts.lyrics !== undefined ? { lyrics: opts.lyrics } : {}),
  });

  const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Shared shelf' });
  await addPlaylistTracks(testDb.db, {
    ownerUserId,
    playlistId: playlist.id,
    trackIds: [trackId],
  });
  await setPlaylistShared(testDb.db, {
    ownerUserId,
    playlistId: playlist.id,
    audience: { kind: 'everyone' },
  });

  return { ownerUserId, trackId, coverImageId, playlistId: playlist.id };
}

async function signInFreshVisitor(): Promise<string> {
  const visitorUserId = await createUser(testDb.db);
  holder.viewerUserId = visitorUserId;
  return visitorUserId;
}

const served: Response[] = [];

async function call<P extends Record<string, string>>(
  handler: (req: Request, ctx: { params: Promise<P> }) => Promise<Response>,
  url: string,
  params: P,
): Promise<Response> {
  const response = await handler(new Request(`http://localhost${url}`), {
    params: Promise.resolve(params),
  });
  served.push(response);
  return response;
}

const audio = (trackId: string) => call(getAudio, `/api/audio/${trackId}`, { trackId });
/** An audio request with headers (Range, If-None-Match) and an optional query. */
async function audioWith(
  trackId: string,
  headers: Record<string, string>,
  query = '',
): Promise<Response> {
  const response = await getAudio(
    new Request(`http://localhost/api/audio/${trackId}${query}`, { headers }),
    { params: Promise.resolve({ trackId }) },
  );
  served.push(response);
  return response;
}
const cover = (id: string) => call(getCover, `/api/covers/${id}`, { id });
const details = (trackId: string) =>
  call(getDetails, `/api/tracks/${trackId}/details`, { trackId });
const lyrics = (trackId: string) => call(getLyrics, `/api/tracks/${trackId}/lyrics`, { trackId });

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('lounge-audible-routes-test');
  dataRoot = await mkdtemp(path.join(tmpdir(), 'liedmotif-lounge-'));
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
  await truncateTables(testDb.pool, FIXTURE_TABLES);
  holder.viewerUserId = null;
  holder.musicProviderCalls = 0;
});

afterEach(async () => {
  for (const response of served.splice(0)) {
    if (!response.bodyUsed) await response.body?.cancel().catch(() => undefined);
  }
});

describe.skipIf(skip)('Lounge-audible read widening', () => {
  describe('selected audience', () => {
    it('serves audio and cover to a picked User and a uniform 404 to everyone else', async () => {
      const { ownerUserId, trackId, coverImageId, playlistId } = await seedSharedTrack();
      const picked = await createUser(testDb.db);
      await setPlaylistShared(testDb.db, {
        ownerUserId,
        playlistId,
        audience: { kind: 'selected', userIds: [picked] },
      });

      holder.viewerUserId = picked;
      expect((await audio(trackId)).status).toBe(200);
      expect((await cover(coverImageId)).status).toBe(200);

      await signInFreshVisitor();
      const hidden = await audio(trackId);
      const unknown = await audio(randomUUID());
      expect(hidden.status).toBe(404);
      expect(await hidden.text()).toBe(await unknown.text());
      expect((await cover(coverImageId)).status).toBe(404);
    });
  });

  describe('audio bytes', () => {
    it('streams a foreign Lounge-audible track to a visitor', async () => {
      const { trackId } = await seedSharedTrack();
      await signInFreshVisitor();

      const res = await audio(trackId);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(AUDIO_BYTES)).toBe(true);
    });

    it('revokes with a 404 indistinguishable from an unknown id after unshare', async () => {
      const { ownerUserId, trackId, playlistId } = await seedSharedTrack();
      await setPlaylistShared(testDb.db, { ownerUserId, playlistId, audience: null });
      await signInFreshVisitor();

      const revoked = await audio(trackId);
      const unknown = await audio(randomUUID());
      expect(revoked.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(await revoked.text()).toBe(await unknown.text());
    });

    it('revokes after removal from the last sharing playlist, even while the track stays saved privately', async () => {
      const { ownerUserId, trackId, playlistId } = await seedSharedTrack();
      // Still Durable in a PRIVATE playlist: retention must not grant audibility.
      const privateShelf = await createPlaylist(testDb.db, { ownerUserId, name: 'Private' });
      await addPlaylistTracks(testDb.db, {
        ownerUserId,
        playlistId: privateShelf.id,
        trackIds: [trackId],
      });
      await removePlaylistTrack(testDb.db, { ownerUserId, playlistId, trackId });
      await signInFreshVisitor();

      expect((await audio(trackId)).status).toBe(404);
    });

    it('revokes after the owner deletes the track', async () => {
      const { ownerUserId, trackId } = await seedSharedTrack();
      await deleteTrack(testDb.db, { ownerUserId, trackId });
      await signInFreshVisitor();

      expect((await audio(trackId)).status).toBe(404);
    });

    it('is owner-anchored: a foreign membership in SOMEONE ELSE’S shared playlist grants nothing', async () => {
      const { ownerUserId, trackId, playlistId } = await seedSharedTrack();
      await setPlaylistShared(testDb.db, { ownerUserId, playlistId, audience: null });

      // A future Shared reference: another member files the (now private) track
      // into their own In-Lounge playlist. Only the OWNER's share may grant.
      const referrerUserId = await createUser(testDb.db);
      const referrerShelf = await createPlaylist(testDb.db, {
        ownerUserId: referrerUserId,
        name: 'Mixtape of references',
      });
      await setPlaylistShared(testDb.db, {
        ownerUserId: referrerUserId,
        playlistId: referrerShelf.id,
        audience: { kind: 'everyone' },
      });
      await testDb.pool.query(
        'insert into playlist_tracks (playlist_id, track_id, position) values ($1, $2, 0)',
        [referrerShelf.id, trackId],
      );

      await signInFreshVisitor();
      expect((await audio(trackId)).status).toBe(404);
    });

    describe.each([
      ['unpinned', ''],
      ['pinned ?asset=final', '?asset=final'],
    ])("a Visitor's final must be revalidated on every play (%s)", (_label, query) => {
      it('200, 206 and 304 all carry private, no-cache', async () => {
        const { trackId } = await seedSharedTrack();
        await signInFreshVisitor();

        const full = await audioWith(trackId, {}, query);
        const ranged = await audioWith(trackId, { range: 'bytes=0-3' }, query);
        const etag = full.headers.get('etag')!;
        const notModified = await audioWith(trackId, { 'if-none-match': etag }, query);

        expect([full.status, ranged.status, notModified.status]).toEqual([200, 206, 304]);
        for (const res of [full, ranged, notModified]) {
          expect(res.headers.get('cache-control')).toBe('private, no-cache');
        }
      });

      it('a revoked Track answers a matching If-None-Match with the unknown-id 404, not a 304', async () => {
        const { ownerUserId, trackId, playlistId } = await seedSharedTrack();
        await signInFreshVisitor();
        const etag = (await audioWith(trackId, {}, query)).headers.get('etag')!;
        await setPlaylistShared(testDb.db, { ownerUserId, playlistId, audience: null });

        const revoked = await audioWith(trackId, { 'if-none-match': etag }, query);
        const unknown = await audioWith(randomUUID(), { 'if-none-match': etag }, query);
        expect(revoked.status).toBe(404);
        expect(await revoked.text()).toBe(await unknown.text());
      });
    });

    it('keeps serving the owner when the playlist is private (no regression)', async () => {
      const { ownerUserId, trackId, playlistId } = await seedSharedTrack();
      await setPlaylistShared(testDb.db, { ownerUserId, playlistId, audience: null });
      holder.viewerUserId = ownerUserId;

      expect((await audio(trackId)).status).toBe(200);
    });
  });

  describe('cover bytes', () => {
    it('serves the session cover of a foreign Lounge-audible track, and revokes on unshare', async () => {
      const { ownerUserId, coverImageId, playlistId } = await seedSharedTrack();
      await signInFreshVisitor();

      const shared = await cover(coverImageId);
      expect(shared.status).toBe(200);
      expect(Buffer.from(await shared.arrayBuffer()).equals(COVER_BYTES)).toBe(true);

      await setPlaylistShared(testDb.db, { ownerUserId, playlistId, audience: null });
      const revoked = await cover(coverImageId);
      const unknown = await cover(randomUUID());
      expect(revoked.status).toBe(404);
      expect(await revoked.text()).toBe(await unknown.text());
    });

    it('serves an In-Lounge playlist’s custom cover cross-owner, only while shared', async () => {
      const ownerUserId = await createUser(testDb.db);
      const coverKey = `covers/${ownerUserId}/playlist-custom.webp`;
      await storage.write({ key: coverKey, body: COVER_BYTES, mimeType: 'image/webp' });
      const [row] = await testDb.db
        .insert(coverImages)
        .values({
          sourceType: 'uploaded',
          storageProvider: 'local-fs',
          storageKey: coverKey,
          provenance: { ownerUserId },
        })
        .returning({ id: coverImages.id });
      const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Curated' });
      await testDb.pool.query('update playlists set cover_image_id = $1 where id = $2', [
        row!.id,
        playlist.id,
      ]);
      await signInFreshVisitor();

      expect((await cover(row!.id)).status).toBe(404);
      await setPlaylistShared(testDb.db, {
        ownerUserId,
        playlistId: playlist.id,
        audience: { kind: 'everyone' },
      });
      expect((await cover(row!.id)).status).toBe(200);
    });
  });

  describe('Track Data (details)', () => {
    it('answers a visitor while Lounge-audible, then 404s uniformly after unshare', async () => {
      const { ownerUserId, trackId, playlistId } = await seedSharedTrack();
      await signInFreshVisitor();

      const shared = await details(trackId);
      expect(shared.status).toBe(200);

      await setPlaylistShared(testDb.db, { ownerUserId, playlistId, audience: null });
      const revoked = await details(trackId);
      const unknown = await details(randomUUID());
      expect(revoked.status).toBe(404);
      expect(await revoked.json()).toEqual(await unknown.json());
    });
  });

  describe('lyrics', () => {
    it('serves a shared vocal track’s captured lyrics to a visitor, and revokes on unshare', async () => {
      const { ownerUserId, trackId, playlistId } = await seedSharedTrack({
        vocal: true,
        lyrics: 'la la lounge',
      });
      await signInFreshVisitor();

      const shared = await lyrics(trackId);
      expect(shared.status).toBe(200);
      const payload = await shared.json();
      expect(payload.data.state).toBe('ready');
      expect(payload.data.lines.map((l: { text: string }) => l.text)).toContain('la la lounge');

      await setPlaylistShared(testDb.db, { ownerUserId, playlistId, audience: null });
      expect((await lyrics(trackId)).status).toBe(404);
    });

    it('syncs a shared track on a visitor’s first open, on the owner’s ledger, then serves the cache', async () => {
      const { ownerUserId, trackId } = await seedSharedTrack({
        vocal: true,
        lyrics: 'la la lounge\nkeep it low',
      });
      await signInFreshVisitor();

      // An offline sync copies every vocal Track and must not buy timing for them.
      const cached = await call(getLyrics, `/api/tracks/${trackId}/lyrics?cached`, { trackId });
      expect((await cached.json()).data.synced).toBe(false);
      expect(holder.musicProviderCalls).toBe(0);

      const first = await (await lyrics(trackId)).json();
      expect(first.data.synced).toBe(true);
      const charged = (await testDb.db.select().from(usageEvents)).filter(
        (event) => event.operation === 'timestamped_lyrics',
      );
      expect(charged.map((event) => event.userId)).toEqual([ownerUserId]);

      await signInFreshVisitor();
      const second = await (await lyrics(trackId)).json();
      expect(second.data.synced).toBe(true);
      expect(holder.musicProviderCalls).toBe(1);
    });

    it('never lets a visitor backfill missing words', async () => {
      // Vocal, job complete, lyrics NOT captured yet: an owner open would re-read
      // the provider's status. A visitor open degrades to "no words" without it.
      const { trackId } = await seedSharedTrack({ vocal: true, lyrics: null });
      await signInFreshVisitor();

      const res = await lyrics(trackId);
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.data.lines).toEqual([]);
      expect(holder.musicProviderCalls).toBe(0);
    });
  });

  describe('downloads never widen', () => {
    it('refuses a visitor the single-track download of a Lounge-audible track', async () => {
      const { trackId } = await seedSharedTrack();
      await signInFreshVisitor();

      // The same visitor streams it (widened read)…
      expect((await audio(trackId)).status).toBe(200);
      // …but cannot take it out of the app: 404, indistinguishable from unknown.
      const refused = await call(getTrackDownload, `/api/tracks/${trackId}/download`, { trackId });
      const unknownId = randomUUID();
      const unknown = await call(getTrackDownload, `/api/tracks/${unknownId}/download`, {
        trackId: unknownId,
      });
      expect(refused.status).toBe(404);
      expect(await refused.text()).toBe(await unknown.text());
    });

    it('refuses a visitor the zip of a foreign In-Lounge playlist', async () => {
      const { playlistId } = await seedSharedTrack();
      await signInFreshVisitor();

      const refused = await call(getPlaylistDownload, `/api/playlists/${playlistId}/download`, {
        playlistId,
      });
      expect(refused.status).toBe(404);
    });
  });
});
