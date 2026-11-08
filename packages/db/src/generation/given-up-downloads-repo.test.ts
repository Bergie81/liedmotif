import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import {
  createGenerationRequest,
  createProviderJob,
  createSession,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
  type TrackFixture,
} from './test-fixtures';
import { generationOutputs, trackAudioAssets, tracks } from '../schema';
import { listGivenUpSavedDownloads, PROVIDER_FINAL_RETENTION_MS } from './given-up-downloads-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const NOW = new Date('2026-10-26T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60_000;

describeIfDb('listGivenUpSavedDownloads', () => {
  let testDb: TestDb;
  let ownerUserId: string;
  let sessionId: string;

  beforeAll(async () => {
    testDb = await connectTestDb('given-up-downloads-repo-test');
  }, 60_000);
  afterAll(async () => {
    await testDb?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(testDb.pool, ['generation_outputs', ...GENERATION_FIXTURE_TABLES]);
    ownerUserId = await createUser(testDb.db);
    sessionId = await createSession(testDb.db, { ownerUserId });
  });

  /**
   * A Track whose final download was given up on: `streamable`, Saved, holding
   * a sealed provider final, with the storage-failure mark on its ledger row.
   */
  async function givenUpTrack(
    overrides: Partial<TrackFixture> & {
      finalUrl?: string | null;
      storageFailedAt?: Date | null;
    } = {},
  ): Promise<string> {
    const { finalUrl, storageFailedAt, ...trackOverrides } = overrides;
    const requestId = await createGenerationRequest(testDb.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
    const trackId = await createTrack(testDb.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      status: 'streamable',
      savedAt: new Date(NOW.getTime() - DAY_MS),
      createdAt: new Date(NOW.getTime() - 5 * DAY_MS),
      ...trackOverrides,
    });
    if (finalUrl !== null) {
      await testDb.db.insert(trackAudioAssets).values({
        trackId,
        assetType: 'provider_final',
        storageProvider: 'provider',
        encryptedSourceUrl: finalUrl ?? 'sealed-final-url',
        isPlayable: true,
      });
    }
    const [row] = await testDb.db
      .select({ analyticsId: tracks.analyticsId })
      .from(tracks)
      .where(eq(tracks.id, trackId));
    await testDb.db.insert(generationOutputs).values({
      ownerUserId,
      analyticsTrackId: row!.analyticsId,
      trackId,
      storageFailedAt:
        storageFailedAt === undefined ? new Date(NOW.getTime() - DAY_MS) : storageFailedAt,
    });
    return trackId;
  }

  it('selects a Saved streamable Track whose given-up final is still within provider retention', async () => {
    const saved = await givenUpTrack();

    expect(await listGivenUpSavedDownloads(testDb.db, { now: NOW })).toEqual([saved]);
  });

  it('skips unsaved, rejected, downloaded, still-retrying, final-less and expired Tracks', async () => {
    await givenUpTrack({ savedAt: null });
    await givenUpTrack({ status: 'rejected', dislikedAt: new Date(NOW.getTime() - DAY_MS) });
    await givenUpTrack({ status: 'deleted' });
    await givenUpTrack({ status: 'ready', audioStorageKey: 'tracks/landed.mp3' });
    await givenUpTrack({ audioStorageKey: 'tracks/landed-not-flipped.mp3' });
    await givenUpTrack({ storageFailedAt: null });
    await givenUpTrack({ finalUrl: null });
    await givenUpTrack({
      createdAt: new Date(NOW.getTime() - PROVIDER_FINAL_RETENTION_MS - DAY_MS),
    });

    expect(await listGivenUpSavedDownloads(testDb.db, { now: NOW })).toEqual([]);
  });

  it('caps one run at the batch limit, oldest Track first', async () => {
    const older = await givenUpTrack({ createdAt: new Date(NOW.getTime() - 6 * DAY_MS) });
    await givenUpTrack({ createdAt: new Date(NOW.getTime() - 2 * DAY_MS) });

    expect(await listGivenUpSavedDownloads(testDb.db, { now: NOW, limit: 1 })).toEqual([older]);
  });
});
