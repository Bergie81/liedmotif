import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import {
  createGenerationRequest,
  createProviderJob,
  createQueueItem,
  createSession,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
} from './test-fixtures';
import { activitySessionQueueItems, trackAudioAssets, tracks } from '../schema';
import { MAX_EXPORT_TRACKS } from './audio-asset-predicates';
import { getOwnedDownloadableTrack, getOwnedSessionDownloadTracks } from './download-tracks-repo';

const skip = !TEST_DATABASE_URL;

let testDb: TestDb;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('session-download-repo-test');
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, GENERATION_FIXTURE_TABLES);
});

/** A ready track with a local final in the session, optionally on a queue slot. */
async function seedDownloadableTrack(fx: {
  ownerUserId: string;
  sessionId: string;
  title?: string | null;
  storageKey?: string;
  mimeType?: string;
  byteSize?: number;
  queuePosition?: number;
  createdAt?: Date;
}): Promise<string> {
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId: fx.ownerUserId,
    activitySessionId: fx.sessionId,
  });
  const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  const trackId = await createTrack(testDb.db, {
    ownerUserId: fx.ownerUserId,
    generationRequestId: requestId,
    providerJobId: jobId,
    title: fx.title ?? null,
    audioStorageKey: fx.storageKey ?? `tracks/${fx.ownerUserId}/s/${Math.random()}.mp3`,
    audioMimeType: fx.mimeType,
    audioByteSize: fx.byteSize,
    ...(fx.createdAt ? { createdAt: fx.createdAt } : {}),
  });
  if (fx.queuePosition !== undefined) {
    await createQueueItem(testDb.db, {
      activitySessionId: fx.sessionId,
      trackId,
      generationRequestId: requestId,
      position: fx.queuePosition,
    });
  }
  return trackId;
}

describe.skipIf(skip)('getOwnedSessionDownloadTracks', () => {
  it('returns downloadable tracks in play order, never-enqueued siblings last', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    const second = await seedDownloadableTrack({
      ownerUserId,
      sessionId,
      title: 'Second Up',
      queuePosition: 5,
      createdAt: new Date('2026-07-01T10:00:00Z'),
    });
    const first = await seedDownloadableTrack({
      ownerUserId,
      sessionId,
      title: 'First Up',
      storageKey: `tracks/${ownerUserId}/s/first.mp3`,
      mimeType: 'audio/mpeg',
      byteSize: 123_456,
      queuePosition: 2,
      createdAt: new Date('2026-07-01T11:00:00Z'),
    });
    // A reroll sibling that never reached the queue sorts after ordered slots.
    const sibling = await seedDownloadableTrack({
      ownerUserId,
      sessionId,
      title: 'Sibling',
      createdAt: new Date('2026-07-01T09:00:00Z'),
    });

    const result = await getOwnedSessionDownloadTracks(testDb.db, { ownerUserId, sessionId });

    expect(result.map((t) => t.trackId)).toEqual([first, second, sibling]);
    expect(result[0]).toMatchObject({
      trackId: first,
      title: 'First Up',
      storageKey: `tracks/${ownerUserId}/s/first.mp3`,
      mimeType: 'audio/mpeg',
      byteSize: 123_456,
    });
  });

  it('reads no more than the export ceiling, from the head of the order', async () => {
    // Every returned row costs the download plan a storage stat and a tag-context
    // row before a byte streams, so an unbounded read lets one request fan a whole
    // library out over the storage backend.
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    const requestId = await createGenerationRequest(testDb.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
    // Seeded in three multi-row inserts: one fixture call per row is ~1,500
    // round-trips, which outlasts the test timeout on CI.
    const positions = Array.from({ length: MAX_EXPORT_TRACKS + 1 }, (_, index) => index);
    const seeded = await testDb.db
      .insert(tracks)
      .values(
        positions.map((position) => ({
          ownerUserId,
          generationRequestId: requestId,
          providerJobId: jobId,
          providerKey: 'mock',
          providerTrackId: `export-ceiling-${position}`,
          prompt: 'instrumental lofi, low energy',
          status: 'ready' as const,
        })),
      )
      .returning({ id: tracks.id });
    await testDb.db.insert(trackAudioAssets).values(
      seeded.map(({ id }, position) => ({
        trackId: id,
        assetType: 'local_original' as const,
        storageProvider: 'local-fs',
        storageKey: `tracks/${ownerUserId}/s/${position}.mp3`,
        isPlayable: true,
      })),
    );
    await testDb.db.insert(activitySessionQueueItems).values(
      seeded.map(({ id }, position) => ({
        activitySessionId: sessionId,
        trackId: id,
        generationRequestId: requestId,
        position,
        state: 'queued' as const,
      })),
    );

    const result = await getOwnedSessionDownloadTracks(testDb.db, { ownerUserId, sessionId });

    expect(result).toHaveLength(MAX_EXPORT_TRACKS);
    expect(result.at(-1)!.storageKey).toBe(`tracks/${ownerUserId}/s/${MAX_EXPORT_TRACKS - 1}.mp3`);
  });

  it('excludes disliked, stream-only, pending, and asset-less tracks', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    const keeper = await seedDownloadableTrack({ ownerUserId, sessionId, queuePosition: 0 });

    const requestId = await createGenerationRequest(testDb.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
    // Disliked: excluded even if an asset row lingers (belt to the structural drop).
    await createTrack(testDb.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      status: 'rejected',
      dislikedAt: new Date(),
      audioStorageKey: `tracks/${ownerUserId}/s/disliked.mp3`,
    });
    // Stream-only: no local bytes to zip.
    await createTrack(testDb.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      status: 'streamable',
      streamEncryptedSourceUrl: 'enc:stream',
    });
    // Pending: nothing servable.
    await createTrack(testDb.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      status: 'pending',
    });
    // Ready but asset-less (should not happen, but must not 500 a zip).
    await createTrack(testDb.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      status: 'ready',
    });

    const result = await getOwnedSessionDownloadTracks(testDb.db, { ownerUserId, sessionId });
    expect(result.map((t) => t.trackId)).toEqual([keeper]);
  });

  it('resolves a single owned downloadable track, and null otherwise', async () => {
    const ownerUserId = await createUser(testDb.db);
    const otherUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    const trackId = await seedDownloadableTrack({
      ownerUserId,
      sessionId,
      title: 'Solo',
      storageKey: `tracks/${ownerUserId}/s/solo.mp3`,
      mimeType: 'audio/mpeg',
      byteSize: 42,
    });

    expect(await getOwnedDownloadableTrack(testDb.db, { ownerUserId, trackId })).toEqual({
      trackId,
      title: 'Solo',
      storageKey: `tracks/${ownerUserId}/s/solo.mp3`,
      mimeType: 'audio/mpeg',
      byteSize: 42,
    });
    expect(
      await getOwnedDownloadableTrack(testDb.db, { ownerUserId: otherUserId, trackId }),
    ).toBeNull();

    const requestId = await createGenerationRequest(testDb.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
    const streamOnly = await createTrack(testDb.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      status: 'streamable',
      streamEncryptedSourceUrl: 'enc:stream',
    });
    expect(
      await getOwnedDownloadableTrack(testDb.db, { ownerUserId, trackId: streamOnly }),
    ).toBeNull();
  });

  it('returns nothing for a foreign or unknown session', async () => {
    const ownerUserId = await createUser(testDb.db);
    const otherUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    await seedDownloadableTrack({ ownerUserId, sessionId, queuePosition: 0 });

    expect(
      await getOwnedSessionDownloadTracks(testDb.db, { ownerUserId: otherUserId, sessionId }),
    ).toEqual([]);
    expect(
      await getOwnedSessionDownloadTracks(testDb.db, {
        ownerUserId,
        sessionId: '00000000-0000-4000-8000-000000000000',
      }),
    ).toEqual([]);
  });
});
