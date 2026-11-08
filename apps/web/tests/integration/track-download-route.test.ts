import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readId3Tags } from '@liedmotif/shared';
import { localFsStorageProvider, shortId, type StorageProvider } from '@liedmotif/storage';
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
import {
  applySessionCover,
  currentlyTaggedFile,
  healEnqueueTrackIds,
} from '../helpers/download-fixtures';

// Single-track download route: serves the local final as an
// attachment named `<title-slug>-<id8>.mp3`, always carrying the Session's
// CURRENT tags — stored bytes when they are already up to date, a composed
// `fresh tag ++ stored audio` otherwise. Never falls back to the provider
// stream.

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

const { GET } = await import('@/app/api/tracks/[trackId]/download/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;
let dataRoot: string;
let storage: StorageProvider;

/** The audio frames under whatever leading tag a fixture carries. */
const AUDIO = new Uint8Array([1, 2, 3, 4]);
/** A branded `.jpg` cover passes into `APIC` verbatim (no re-encode), so a
 *  composed response's artwork bytes are exactly these. */
const COVER_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4, 2]);

let keyCounter = 0;
async function seedDownloadableTrack(
  ownerUserId: string,
  opts: { title?: string | null; audio?: Uint8Array; tagged?: false } = {},
): Promise<{ trackId: string; sessionId: string; key: string; body: Buffer }> {
  keyCounter += 1;
  const sessionId = await createSession(testDb.db, { ownerUserId });
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  const key = `tracks/${ownerUserId}/s/original-${keyCounter}.mp3`;
  const trackId = await createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId: jobId,
    title: opts.title === undefined ? 'Morning Haze' : opts.title,
    audioStorageKey: key,
    audioMimeType: 'audio/mpeg',
  });
  const audio = opts.audio ?? AUDIO;
  const body =
    opts.tagged === false
      ? Buffer.from(audio)
      : await currentlyTaggedFile(testDb.db, trackId, audio);
  await storage.write({ key, body, mimeType: 'audio/mpeg' });
  return { trackId, sessionId, key, body };
}

function applyCover(sessionId: string): Promise<string> {
  keyCounter += 1;
  return applySessionCover(testDb.db, storage, {
    sessionId,
    key: `covers/applied-${keyCounter}.jpg`,
    bytes: COVER_JPEG,
  });
}

function get(trackId: string): Promise<Response> {
  return GET(new Request(`http://test.local/api/tracks/${trackId}/download`), {
    params: Promise.resolve({ trackId }),
  });
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('track-download-route-test');
  dataRoot = await mkdtemp(path.join(tmpdir(), 'liedmotif-download-'));
  storage = localFsStorageProvider({ dataRoot });
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
  await rm(dataRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, [...GENERATION_FIXTURE_TABLES, 'cover_images']);
  holder.db = testDb.db;
  holder.storage = storage;
  holder.ownerUserId = null;
  enqueueEmbedTrackMetadataBatch.mockClear();
});

describe.skipIf(skip)('GET /api/tracks/[trackId]/download', () => {
  it('serves the stored bytes as a named attachment without re-enqueueing a current file', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const { trackId, body } = await seedDownloadableTrack(ownerUserId);
    const id8 = shortId(trackId);

    const response = await get(trackId);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="morning-haze-${id8}.mp3"`,
    );
    expect(response.headers.get('content-length')).toBe(String(body.length));
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
    expect(healEnqueueTrackIds(enqueueEmbedTrackMetadataBatch)).toEqual([]);
  });

  it('carries a just-applied Session Cover, before any worker retag', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const { trackId, sessionId, body: stale } = await seedDownloadableTrack(ownerUserId);
    await applyCover(sessionId);

    const response = await get(trackId);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes).not.toEqual(stale);
    const parsed = readId3Tags(bytes)!;
    expect(parsed.hasArtwork).toBe(true);
    expect(parsed.title).toBe('Morning Haze');
    expect(bytes).toEqual(
      await currentlyTaggedFile(testDb.db, trackId, AUDIO, {
        mediaType: 'image/jpeg',
        bytes: COVER_JPEG,
      }),
    );
    expect(response.headers.get('content-length')).toBe(String(bytes.length));
    expect(healEnqueueTrackIds(enqueueEmbedTrackMetadataBatch)).toEqual([[trackId]]);
  });

  it('falls back to the id-only filename for an untitled track', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const { trackId } = await seedDownloadableTrack(ownerUserId, { title: null });
    const id8 = shortId(trackId);

    const response = await get(trackId);
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="track-${id8}.mp3"`,
    );
  });

  it('tags an untagged file in the response and enqueues the embed job', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const { trackId } = await seedDownloadableTrack(ownerUserId, { tagged: false });

    const response = await get(trackId);
    expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes).toEqual(await currentlyTaggedFile(testDb.db, trackId, AUDIO));
    expect(response.headers.get('content-length')).toBe(String(bytes.length));
    expect(healEnqueueTrackIds(enqueueEmbedTrackMetadataBatch)).toEqual([[trackId]]);
  });

  it('404s unauthenticated, malformed, foreign, stream-only, and missing-bytes tracks', async () => {
    const ownerUserId = await createUser(testDb.db);
    const otherUserId = await createUser(testDb.db);
    const { trackId, key } = await seedDownloadableTrack(ownerUserId);

    expect((await get(trackId)).status).toBe(401);

    holder.ownerUserId = otherUserId;
    expect((await get(trackId)).status).toBe(404);
    expect((await get('not-a-uuid')).status).toBe(404);

    holder.ownerUserId = ownerUserId;
    const requestId = await createGenerationRequest(testDb.db, { ownerUserId });
    const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
    const streamOnly = await createTrack(testDb.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      status: 'streamable',
      streamEncryptedSourceUrl: 'enc:stream',
    });
    expect((await get(streamOnly)).status).toBe(404);

    await storage.delete(key);
    expect((await get(trackId)).status).toBe(404);
  });
});
