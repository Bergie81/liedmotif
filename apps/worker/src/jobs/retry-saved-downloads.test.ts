import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { generationOutputs, trackAudioAssets, tracks } from '@liedmotif/db';
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
import { createRetrySavedDownloadsTask } from './retry-saved-downloads';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('retry-saved-downloads', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-retry-saved-downloads-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, ['generation_outputs', ...GENERATION_FIXTURE_TABLES]);
  });

  /** A Saved `streamable` Track whose download already gave up. */
  async function givenUpSavedTrack(): Promise<string> {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
    const trackId = await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      status: 'streamable',
      savedAt: new Date(),
    });
    await ctx.db.insert(trackAudioAssets).values({
      trackId,
      assetType: 'provider_final',
      storageProvider: 'provider',
      encryptedSourceUrl: 'sealed-final-url',
      isPlayable: true,
    });
    const [row] = await ctx.db
      .select({ analyticsId: tracks.analyticsId })
      .from(tracks)
      .where(eq(tracks.id, trackId));
    await ctx.db.insert(generationOutputs).values({
      ownerUserId,
      analyticsTrackId: row!.analyticsId,
      trackId,
      storageFailedAt: new Date(),
    });
    return trackId;
  }

  async function storageFailedAt(trackId: string): Promise<Date | null> {
    const [row] = await ctx.db
      .select({ at: generationOutputs.storageFailedAt })
      .from(generationOutputs)
      .where(eq(generationOutputs.trackId, trackId));
    return row!.at;
  }

  const helpersWith = (addJob: ReturnType<typeof vi.fn>) =>
    ({ addJob, logger: { info: () => undefined } }) as never;

  it('re-enqueues the keyed final-audio download once per give-up', async () => {
    const trackId = await givenUpSavedTrack();
    const addJob = vi.fn(async () => undefined);
    const task = createRetrySavedDownloadsTask({ db: ctx.db });

    await task({}, helpersWith(addJob));

    expect(addJob).toHaveBeenCalledTimes(1);
    expect(addJob).toHaveBeenCalledWith(
      'download-final-audio',
      { trackId },
      { jobKey: `download:${trackId}` },
    );
    expect(await storageFailedAt(trackId)).toBeNull();

    // The retry now owns the Track until it lands or gives up again.
    await task({}, helpersWith(addJob));
    expect(addJob).toHaveBeenCalledTimes(1);
  });

  it('keeps the give-up mark when the enqueue fails, so the next run retries', async () => {
    const trackId = await givenUpSavedTrack();
    const addJob = vi.fn(async () => {
      throw new Error('queue unavailable');
    });

    await expect(
      createRetrySavedDownloadsTask({ db: ctx.db })({}, helpersWith(addJob)),
    ).rejects.toThrow('queue unavailable');

    expect(await storageFailedAt(trackId)).not.toBeNull();
  });
});
