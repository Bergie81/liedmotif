import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readId3Tags } from '@liedmotif/shared';
import { localFsStorageProvider, shortId, type StorageProvider } from '@liedmotif/storage';
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
import {
  applySessionCover,
  currentlyTaggedFile,
  healEnqueueTrackIds,
} from '../helpers/download-fixtures';

// Session zip download route: streams a STORE-mode zip named <sessionId>.zip
// whose entries are the session's downloadable tracks in play order with a
// three-digit prefix (Decisions 1-3), each carrying the Session's CURRENT tags.
// Stream-only, disliked, and missing-on-disk tracks are skipped; an empty result
// is a uniform 404.

const holder = vi.hoisted(() => ({
  db: null as unknown,
  storage: null as unknown,
  ownerUserId: null as string | null,
}));

const enqueueEmbedTrackMetadataBatch = vi.hoisted(() =>
  vi.fn(async (_db: unknown, _trackIds: string[]) => undefined),
);

vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/providers/providers', () => ({ getStorageProvider: () => holder.storage }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
vi.mock('@/lib/worker-jobs', () => ({ enqueueEmbedTrackMetadataBatch }));

const { GET } = await import('@/app/api/sessions/[sessionId]/download/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;
let dataRoot: string;
let storage: StorageProvider;

/** The audio frames under whatever leading tag a fixture carries. */
const AUDIO = new Uint8Array([1, 2, 3, 4]);
/** A branded `.jpg` cover passes into `APIC` verbatim (no re-encode). */
const COVER_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4, 2]);

let keyCounter = 0;
async function seedSessionTrack(fx: {
  ownerUserId: string;
  sessionId: string;
  title?: string | null;
  queuePosition?: number;
  withFile?: boolean;
  streamOnly?: boolean;
}): Promise<{ trackId: string; key: string; body: Buffer }> {
  keyCounter += 1;
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId: fx.ownerUserId,
    activitySessionId: fx.sessionId,
  });
  const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  const key = `tracks/${fx.ownerUserId}/s/original-${keyCounter}.mp3`;
  const trackId = await createTrack(testDb.db, {
    ownerUserId: fx.ownerUserId,
    generationRequestId: requestId,
    providerJobId: jobId,
    title: fx.title ?? null,
    ...(fx.streamOnly
      ? { status: 'streamable' as const, streamEncryptedSourceUrl: 'enc:stream' }
      : { audioStorageKey: key, audioMimeType: 'audio/mpeg' }),
  });
  let body: Buffer = Buffer.alloc(0);
  if (fx.withFile !== false && !fx.streamOnly) {
    body = await currentlyTaggedFile(testDb.db, trackId, AUDIO);
    await storage.write({ key, body, mimeType: 'audio/mpeg' });
  }
  if (fx.queuePosition !== undefined) {
    await createQueueItem(testDb.db, {
      activitySessionId: fx.sessionId,
      trackId,
      generationRequestId: requestId,
      position: fx.queuePosition,
    });
  }
  return { trackId, key, body };
}

function applyCover(sessionId: string): Promise<string> {
  keyCounter += 1;
  return applySessionCover(testDb.db, storage, {
    sessionId,
    key: `covers/applied-${keyCounter}.jpg`,
    bytes: COVER_JPEG,
  });
}

function get(sessionId: string): Promise<Response> {
  return GET(new Request(`http://test.local/api/sessions/${sessionId}/download`), {
    params: Promise.resolve({ sessionId }),
  });
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('session-download-route-test');
  dataRoot = await mkdtemp(path.join(tmpdir(), 'liedmotif-session-zip-'));
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

describe.skipIf(skip)('GET /api/sessions/[sessionId]/download', () => {
  it('streams a zip of the downloadable tracks, play-ordered with NNN- prefixes', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId });
    const second = await seedSessionTrack({
      ownerUserId,
      sessionId,
      title: 'Beta',
      queuePosition: 7,
    });
    const first = await seedSessionTrack({
      ownerUserId,
      sessionId,
      title: 'Alpha',
      queuePosition: 3,
    });
    await seedSessionTrack({ ownerUserId, sessionId, streamOnly: true });
    const missing = await seedSessionTrack({
      ownerUserId,
      sessionId,
      title: 'Gone',
      queuePosition: 5,
      withFile: false,
    });

    const response = await get(sessionId);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="${sessionId}.zip"`,
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');

    const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
    const firstId8 = shortId(first.trackId);
    const secondId8 = shortId(second.trackId);
    expect(zip.getEntries().map((entry) => entry.entryName)).toEqual([
      `001-alpha-${firstId8}.mp3`,
      `002-beta-${secondId8}.mp3`,
    ]);
    expect(zip.getEntries().map((entry) => entry.getData())).toEqual([first.body, second.body]);
    expect(missing.trackId).toBeTruthy();
    expect(healEnqueueTrackIds(enqueueEmbedTrackMetadataBatch)).toEqual([]);
  });

  it('carries a just-applied Session Cover in every entry, before any worker retag', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId });
    const first = await seedSessionTrack({ ownerUserId, sessionId, queuePosition: 1 });
    const second = await seedSessionTrack({ ownerUserId, sessionId, queuePosition: 2 });
    await applyCover(sessionId);

    const response = await get(sessionId);
    const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
    const artwork = { mediaType: 'image/jpeg' as const, bytes: COVER_JPEG };
    expect(zip.getEntries().map((entry) => readId3Tags(entry.getData())!.hasArtwork)).toEqual([
      true,
      true,
    ]);
    expect(zip.getEntries().map((entry) => readId3Tags(entry.getData())!.artist)).toEqual([
      'Test Admin',
      'Test Admin',
    ]);
    expect(zip.getEntries().map((entry) => entry.getData())).toEqual([
      await currentlyTaggedFile(testDb.db, first.trackId, AUDIO, artwork),
      await currentlyTaggedFile(testDb.db, second.trackId, AUDIO, artwork),
    ]);
    expect(healEnqueueTrackIds(enqueueEmbedTrackMetadataBatch)).toEqual([
      [first.trackId],
      [second.trackId],
    ]);
  });

  it('streams the response without awaiting the embed enqueue', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId });
    keyCounter += 1;
    const requestId = await createGenerationRequest(testDb.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
    const key = `tracks/${ownerUserId}/s/original-${keyCounter}.mp3`;
    // Untagged bytes → the backstop WILL want to enqueue the embed job.
    await storage.write({ key, body: Buffer.from([9, 9, 9, 9]), mimeType: 'audio/mpeg' });
    const trackId = await createTrack(testDb.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      title: 'Untagged',
      audioStorageKey: key,
      audioMimeType: 'audio/mpeg',
    });
    await createQueueItem(testDb.db, {
      activitySessionId: sessionId,
      trackId,
      generationRequestId: requestId,
      position: 1,
    });

    // The enqueue never resolves during the test: a response that streamed to
    // completion anyway proves the route does not await it.
    enqueueEmbedTrackMetadataBatch.mockImplementation(() => new Promise<undefined>(() => {}));
    const response = await get(sessionId);
    expect(response.status).toBe(200);
    const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
    expect(zip.getEntries()).toHaveLength(1);
    await vi.waitFor(() => expect(enqueueEmbedTrackMetadataBatch).toHaveBeenCalledOnce());
    expect(healEnqueueTrackIds(enqueueEmbedTrackMetadataBatch)).toEqual([[trackId]]);
  });

  it('404s an empty session, a foreign session, and a malformed id', async () => {
    const ownerUserId = await createUser(testDb.db);
    const otherUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    await seedSessionTrack({ ownerUserId, sessionId, streamOnly: true });

    expect((await get(sessionId)).status).toBe(401);

    holder.ownerUserId = ownerUserId;
    expect((await get(sessionId)).status).toBe(404);
    expect((await get('not-a-uuid')).status).toBe(404);

    holder.ownerUserId = otherUserId;
    expect((await get(sessionId)).status).toBe(404);
  });
});
