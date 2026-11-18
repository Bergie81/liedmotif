import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activitySessionQueueItems,
  generationRequests,
  providerJobs,
  trackAudioAssets,
  tracks,
} from '../schema';
import {
  connectTestDb,
  createQueueItem,
  createSession,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';
import { withTransaction } from '../transactions';
import { insertSubmittingGenerationJob, markProviderJobSubmitted } from './submit-repo';
import {
  failFinalLessTracksOfJob,
  getProviderJobForPoll,
  markGenerationRequestFailed,
  updateProviderJobPollState,
} from './provider-poll-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('provider-poll repo', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-provider-poll-repo-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  /** A submitted music job (request carries a style prompt + the captured task id). */
  async function submittedJob(taskId: string | null = 'suno-task-1'): Promise<{
    ownerUserId: string;
    sessionId: string;
    requestId: string;
    jobId: string;
  }> {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const { requestId, jobId } = await withTransaction(ctx.db, (tx) =>
      insertSubmittingGenerationJob(tx, {
        ownerUserId,
        activitySessionId: sessionId,
        providerKey: 'mock',
        stylePrompt: 'instrumental lofi, low energy',
      }),
    );
    if (taskId) await markProviderJobSubmitted(ctx.db, { jobId, providerTaskId: taskId });
    return { ownerUserId, sessionId, requestId, jobId };
  }

  it('loads the joined poll context for an existing job, and null for a missing id', async () => {
    const { ownerUserId, sessionId, requestId, jobId } = await submittedJob('suno-task-1');

    const job = await getProviderJobForPoll(ctx.db, jobId);
    expect(job).toMatchObject({
      jobId,
      ownerUserId,
      activitySessionId: sessionId,
      generationRequestId: requestId,
      providerKey: 'mock',
      providerTaskId: 'suno-task-1',
      normalizedStatus: 'submitted',
      prompt: 'instrumental lofi, low energy',
      retryCount: 0,
    });

    expect(await getProviderJobForPoll(ctx.db, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('persists the polled provider/normalized status, next poll time, and retry count', async () => {
    const { jobId } = await submittedJob('suno-task-1');
    const nextPollAt = new Date('2026-06-30T12:00:30Z');

    await updateProviderJobPollState(ctx.db, {
      jobId,
      providerStatus: 'first_track_ready',
      normalizedStatus: 'partially_ready',
      nextPollAt,
      retryCount: 3,
    });

    const [row] = await ctx.db
      .select({
        providerStatus: providerJobs.providerStatus,
        normalizedStatus: providerJobs.normalizedStatus,
        nextPollAt: providerJobs.nextPollAt,
        retryCount: providerJobs.retryCount,
        providerTaskId: providerJobs.providerTaskId,
      })
      .from(providerJobs)
      .where(eq(providerJobs.id, jobId));
    expect(row).toMatchObject({
      providerStatus: 'first_track_ready',
      normalizedStatus: 'partially_ready',
      retryCount: 3,
      providerTaskId: 'suno-task-1', // never cleared
    });
    expect(row!.nextPollAt?.toISOString()).toBe(nextPollAt.toISOString());
  });

  it('never stores a provider URL — only the status token lands in provider_status', async () => {
    const { jobId } = await submittedJob('suno-task-1');
    await updateProviderJobPollState(ctx.db, {
      jobId,
      providerStatus: 'complete',
      normalizedStatus: 'ready',
      nextPollAt: null,
      retryCount: 5,
    });
    const [row] = await ctx.db
      .select({
        providerStatus: providerJobs.providerStatus,
        rawResponse: providerJobs.rawResponse,
      })
      .from(providerJobs)
      .where(eq(providerJobs.id, jobId));
    expect(row!.providerStatus).toBe('complete');
    expect(row!.providerStatus).not.toMatch(/https?:\/\//);
    expect(row!.rawResponse).toBeNull(); // urls never serialized into rawResponse
  });

  it('compare-and-set: writes when the job is still pollable and reports updated', async () => {
    const { jobId } = await submittedJob('suno-task-1'); // normalizedStatus = submitted
    const res = await updateProviderJobPollState(ctx.db, {
      jobId,
      providerStatus: 'complete',
      normalizedStatus: 'ready',
      nextPollAt: null,
      retryCount: 2,
    });
    expect(res).toEqual({ updated: true });
    const [row] = await ctx.db
      .select({ normalizedStatus: providerJobs.normalizedStatus })
      .from(providerJobs)
      .where(eq(providerJobs.id, jobId));
    expect(row!.normalizedStatus).toBe('ready');
  });

  it('compare-and-set: refuses to overwrite a job that already went terminal (no regression)', async () => {
    const { jobId } = await submittedJob('suno-task-1');
    // A drives the job terminal first.
    await updateProviderJobPollState(ctx.db, {
      jobId,
      providerStatus: 'failed',
      normalizedStatus: 'failed_final',
      nextPollAt: null,
      retryCount: 9,
    });
    // B (stale snapshot) tries to write a non-terminal/ready status afterwards.
    const res = await updateProviderJobPollState(ctx.db, {
      jobId,
      providerStatus: 'complete',
      normalizedStatus: 'ready',
      nextPollAt: null,
      retryCount: 3,
    });
    expect(res).toEqual({ updated: false });
    const [row] = await ctx.db
      .select({
        normalizedStatus: providerJobs.normalizedStatus,
        retryCount: providerJobs.retryCount,
      })
      .from(providerJobs)
      .where(eq(providerJobs.id, jobId));
    // The terminal state and its retry count are untouched — no resurrection.
    expect(row).toMatchObject({ normalizedStatus: 'failed_final', retryCount: 9 });
  });

  it('refuses (money-safety) to drive a job holding a task id back to a paid submit state', async () => {
    const { jobId } = await submittedJob('suno-task-1');
    await expect(
      updateProviderJobPollState(ctx.db, {
        jobId,
        providerStatus: 'pending',
        normalizedStatus: 'submitted',
        nextPollAt: null,
        retryCount: 1,
      }),
    ).rejects.toThrow(/Money-safety/);
  });

  it('marks the generation request failed with a sanitized error code + message', async () => {
    const { requestId } = await submittedJob('suno-task-1');

    await markGenerationRequestFailed(ctx.db, {
      generationRequestId: requestId,
      errorCode: 'insufficient_credit',
      errorMessageSafe: 'Music provider is out of credits.',
    });

    const [row] = await ctx.db
      .select({
        status: generationRequests.status,
        errorCode: generationRequests.errorCode,
        errorMessageSafe: generationRequests.errorMessageSafe,
      })
      .from(generationRequests)
      .where(eq(generationRequests.id, requestId));
    expect(row).toMatchObject({
      status: 'failed',
      errorCode: 'insufficient_credit',
      errorMessageSafe: 'Music provider is out of credits.',
    });
  });

  it('fails only the final-less live Tracks of the failed job and their live Queue slots', async () => {
    const { ownerUserId, sessionId, requestId, jobId } = await submittedJob('suno-task-1');
    const other = await submittedJob('suno-task-2');
    const onJob = (fx: Partial<Parameters<typeof createTrack>[1]> = {}) =>
      createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
        status: 'streamable',
        streamEncryptedSourceUrl: 'enc:stream',
        ...fx,
      });
    const streamOnly = await onJob();
    const playing = await onJob({ savedAt: new Date() });
    const finalOnItsWay = await onJob();
    await ctx.db.insert(trackAudioAssets).values({
      trackId: finalOnItsWay,
      assetType: 'provider_final',
      storageProvider: 'provider',
      encryptedSourceUrl: 'enc:final',
      isPlayable: true,
    });
    const storedFinal = await onJob({ status: 'ready', audioStorageKey: 'a.mp3' });
    const disliked = await onJob({ status: 'rejected', dislikedAt: new Date() });
    const deleted = await onJob({ status: 'deleted' });
    const otherJobs = await createTrack(ctx.db, {
      ownerUserId: other.ownerUserId,
      generationRequestId: other.requestId,
      providerJobId: other.jobId,
      status: 'streamable',
      streamEncryptedSourceUrl: 'enc:stream',
    });
    const slot = (trackId: string, position: number, state: 'queued' | 'playing') =>
      createQueueItem(ctx.db, { activitySessionId: sessionId, trackId, position, state });
    await slot(streamOnly, 0, 'queued');
    await slot(playing, 1, 'playing');
    await slot(finalOnItsWay, 2, 'queued');
    await slot(storedFinal, 3, 'queued');

    const names = new Map<string, string>([
      [streamOnly, 'streamOnly'],
      [playing, 'playing'],
      [finalOnItsWay, 'finalOnItsWay'],
      [storedFinal, 'storedFinal'],
      [disliked, 'disliked'],
      [deleted, 'deleted'],
      [otherJobs, 'otherJobs'],
    ]);

    const result = await failFinalLessTracksOfJob(ctx.db, jobId);

    expect(new Set(result.failedTrackIds)).toEqual(new Set([streamOnly, playing]));
    const statuses = new Map(
      (await ctx.db.select({ id: tracks.id, status: tracks.status }).from(tracks)).map((r) => [
        r.id,
        r.status,
      ]),
    );
    expect(Object.fromEntries([...statuses].map(([id, s]) => [names.get(id), s]))).toEqual({
      streamOnly: 'failed',
      playing: 'failed',
      finalOnItsWay: 'streamable',
      storedFinal: 'ready',
      disliked: 'rejected',
      deleted: 'deleted',
      otherJobs: 'streamable',
    });
    const slots = await ctx.db
      .select({
        trackId: activitySessionQueueItems.trackId,
        state: activitySessionQueueItems.state,
      })
      .from(activitySessionQueueItems);
    expect(Object.fromEntries(slots.map((s) => [names.get(s.trackId!), s.state]))).toEqual({
      streamOnly: 'failed',
      playing: 'failed',
      finalOnItsWay: 'queued',
      storedFinal: 'queued',
    });
    // The stream stays: a Track playing right now plays to its end.
    const streams = await ctx.db
      .select({ isPlayable: trackAudioAssets.isPlayable })
      .from(trackAudioAssets)
      .where(eq(trackAudioAssets.trackId, playing));
    expect(streams).toEqual([{ isPlayable: true }]);
  });
});
