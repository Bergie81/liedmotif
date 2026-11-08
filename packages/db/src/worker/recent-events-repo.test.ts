import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { generationRequests, providerJobs, trackAudioAssets } from '../schema';
import {
  createGenerationRequest,
  createProviderJob,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
} from '../generation/test-fixtures';
import { getRecentWorkerEvents } from './recent-events-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('recent worker events repo', () => {
  let ctx: TestDb;
  let ownerUserId: string;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-recent-events-repo-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
    ownerUserId = await createUser(ctx.db);
  });

  async function seedFailure(at: Date, errorCode: string, safeMessage: string | null) {
    const id = await createGenerationRequest(ctx.db, { ownerUserId, status: 'failed' });
    await ctx.db
      .update(generationRequests)
      .set({ errorCode, errorMessageSafe: safeMessage, updatedAt: at })
      .where(eq(generationRequests.id, id));
    return id;
  }

  async function seedSubmission(at: Date, providerTaskId: string) {
    const requestId = await createGenerationRequest(ctx.db, { ownerUserId });
    const jobId = await createProviderJob(ctx.db, {
      generationRequestId: requestId,
      providerTaskId,
    });
    await ctx.db
      .update(providerJobs)
      .set({ lastSubmitAttemptAt: at })
      .where(eq(providerJobs.id, jobId));
    return jobId;
  }

  async function seedDownload(at: Date, byteSize: number, durationSeconds: number) {
    const requestId = await createGenerationRequest(ctx.db, { ownerUserId });
    const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
    const trackId = await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
    });
    await ctx.db.insert(trackAudioAssets).values({
      trackId,
      assetType: 'local_original',
      storageProvider: 'local-fs',
      storageKey: `tracks/${trackId}.mp3`,
      byteSize,
      durationSeconds,
      isPlayable: true,
      createdAt: at,
    });
    return trackId;
  }

  it('returns an empty feed on a fresh instance', async () => {
    expect(await getRecentWorkerEvents(ctx.db)).toEqual([]);
  });

  it('merges failures, submissions, and downloads newest-first', async () => {
    const failedId = await seedFailure(
      new Date('2026-07-30T12:03:00Z'),
      'GENERATE_AUDIO_FAILED',
      'The provider rejected the request.',
    );
    await seedSubmission(new Date('2026-07-30T12:01:00Z'), 'task_abc12345');
    const trackId = await seedDownload(new Date('2026-07-30T12:02:00Z'), 3_800_000, 161);

    expect(await getRecentWorkerEvents(ctx.db)).toEqual([
      {
        kind: 'generation_failed',
        at: new Date('2026-07-30T12:03:00Z'),
        id: failedId,
        errorCode: 'GENERATE_AUDIO_FAILED',
        safeMessage: 'The provider rejected the request.',
      },
      {
        kind: 'track_downloaded',
        at: new Date('2026-07-30T12:02:00Z'),
        id: trackId,
        byteSize: 3_800_000,
        durationSeconds: 161,
      },
      {
        kind: 'provider_submitted',
        at: new Date('2026-07-30T12:01:00Z'),
        id: 'task_abc12345',
      },
    ]);
  });

  it('caps the merged feed at the limit, keeping the newest entries', async () => {
    for (let i = 0; i < 4; i += 1) {
      await seedSubmission(new Date(`2026-07-30T11:0${i}:00Z`), `task_${i}`);
    }
    await seedFailure(new Date('2026-07-30T12:00:00Z'), 'ERR', null);
    const events = await getRecentWorkerEvents(ctx.db, 3);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ kind: 'generation_failed' });
    expect(events[1]).toMatchObject({ kind: 'provider_submitted', id: 'task_3' });
    expect(events[2]).toMatchObject({ kind: 'provider_submitted', id: 'task_2' });
  });

  it('ignores non-failed requests, unsubmitted jobs, and provider-side assets', async () => {
    // In-flight request (status 'submitting') — not an event.
    await createGenerationRequest(ctx.db, { ownerUserId });
    // Job that never reached the provider — not a submission.
    const requestId = await createGenerationRequest(ctx.db, { ownerUserId });
    await createProviderJob(ctx.db, { generationRequestId: requestId, providerTaskId: null });
    // Provider-side stream asset — not a download.
    const reqId2 = await createGenerationRequest(ctx.db, { ownerUserId });
    const jobId2 = await createProviderJob(ctx.db, { generationRequestId: reqId2 });
    const trackId = await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: reqId2,
      providerJobId: jobId2,
    });
    await ctx.db.insert(trackAudioAssets).values({
      trackId,
      assetType: 'provider_stream',
      storageProvider: 'provider',
      encryptedSourceUrl: 'encrypted:not-a-url',
      isPlayable: true,
    });
    expect(await getRecentWorkerEvents(ctx.db)).toEqual([]);
  });
});
