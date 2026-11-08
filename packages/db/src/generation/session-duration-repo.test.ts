import { eq } from 'drizzle-orm';
import { recordOutputStorageFailure } from '../analytics/generation-repo';
import { generationOutputs, generationRequests, trackAudioAssets, tracks } from '../schema';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  connectTestDb,
  createUser,
  createSession,
  createGenerationRequest,
  createProviderJob,
  createTrack,
  createQueueItem,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';
import {
  getSessionDurationProgress,
  markSessionDurationBatchMaterialized,
  writeMeasuredTrackDuration,
} from './session-duration-repo';

describe.skipIf(!TEST_DATABASE_URL)('Session generated duration', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('session-duration-test');
  }, 60000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  it('counts usable siblings and played/skipped Tracks across revisions once, excluding rejected and unavailable audio', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    let unknownTrackId: string | undefined;
    for (const styleRevision of [1, 2]) {
      const request = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
        styleRevision,
      });
      const job = await createProviderJob(ctx.db, {
        generationRequestId: request,
        normalizedStatus: 'ready',
      });
      for (const [index, durationSeconds] of [120, 180, null, 500].entries()) {
        const id = await createTrack(ctx.db, {
          ownerUserId,
          generationRequestId: request,
          providerJobId: job,
          durationSeconds,
          savedAt: index === 1 ? new Date() : null,
          ...(index === 3 ? {} : { audioStorageKey: `audio/${styleRevision}/${index}` }),
        });
        if (index === 2) unknownTrackId = id;
        if (index === 0)
          await createQueueItem(ctx.db, {
            activitySessionId: sessionId,
            trackId: id,
            position: styleRevision,
            state: styleRevision === 1 ? 'played' : 'skipped',
          });
      }
      await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: request,
        providerJobId: job,
        durationSeconds: 900,
        audioStorageKey: `rejected/${styleRevision}`,
        dislikedAt: new Date(),
      });
    }
    expect(await getSessionDurationProgress(ctx.db, { ownerUserId, sessionId })).toEqual({
      batchOutstanding: false,
      generatedDurationSeconds: 600,
      unknownDurationTrackCount: 2,
    });
    await writeMeasuredTrackDuration(ctx.db, unknownTrackId!, 125.5);
    expect(await getSessionDurationProgress(ctx.db, { ownerUserId, sessionId })).toEqual({
      batchOutstanding: false,
      generatedDurationSeconds: 725,
      unknownDurationTrackCount: 1,
    });
    expect(await getSessionDurationProgress(ctx.db, { ownerUserId: 'other', sessionId })).toEqual({
      batchOutstanding: false,
      generatedDurationSeconds: 0,
      unknownDurationTrackCount: 0,
    });
  });

  it('reads the duration and batch completion together across a concurrent materialization commit', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      status: 'awaiting_results',
    });
    const jobId = await createProviderJob(ctx.db, {
      generationRequestId: requestId,
      normalizedStatus: 'ready',
    });
    const trackId = await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      status: 'pending',
      durationSeconds: 300,
      audioStorageKey: 'duration/concurrent',
    });
    let releaseCommit!: () => void;
    let announceWrites!: () => void;
    const commitAllowed = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const writesReady = new Promise<void>((resolve) => {
      announceWrites = resolve;
    });
    const materialization = ctx.db.transaction(async (tx) => {
      await tx.update(tracks).set({ status: 'ready' }).where(eq(tracks.id, trackId));
      await tx
        .update(generationRequests)
        .set({ status: 'materialized' })
        .where(eq(generationRequests.id, requestId));
      announceWrites();
      await commitAllowed;
    });
    try {
      await Promise.race([writesReady, materialization]);
      expect(await getSessionDurationProgress(ctx.db, { ownerUserId, sessionId })).toEqual({
        generatedDurationSeconds: 0,
        unknownDurationTrackCount: 0,
        batchOutstanding: true,
      });
    } finally {
      releaseCommit();
      await materialization;
    }
    expect(await getSessionDurationProgress(ctx.db, { ownerUserId, sessionId })).toEqual({
      generatedDurationSeconds: 300,
      unknownDurationTrackCount: 0,
      batchOutstanding: false,
    });
  });

  it('releases a submit that never got a task id at the phantom-submit cutoff', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      status: 'submitting',
    });
    const updatedAt = new Date('2026-01-01T12:00:00Z');
    await createProviderJob(ctx.db, {
      generationRequestId: requestId,
      submitState: 'submit_unknown',
      normalizedStatus: 'submit_unknown',
      updatedAt,
    });
    const progress = (cutoffMs: number) =>
      getSessionDurationProgress(ctx.db, {
        ownerUserId,
        sessionId,
        phantomSubmitCutoff: new Date(updatedAt.getTime() + cutoffMs),
      });
    expect((await progress(-1)).batchOutstanding).toBe(true);
    expect((await progress(0)).batchOutstanding).toBe(false);
  });

  it('holds a legacy ready batch until its missing sibling is materialized', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      status: 'submitting',
    });
    const jobId = await createProviderJob(ctx.db, {
      generationRequestId: requestId,
      normalizedStatus: 'ready',
    });
    await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      durationSeconds: 120,
      audioStorageKey: 'duration/legacy-first',
    });
    expect(await getSessionDurationProgress(ctx.db, { ownerUserId, sessionId })).toEqual({
      generatedDurationSeconds: 120,
      unknownDurationTrackCount: 0,
      batchOutstanding: true,
    });
    await markSessionDurationBatchMaterialized(ctx.db, requestId);
    expect(await getSessionDurationProgress(ctx.db, { ownerUserId, sessionId })).toEqual({
      generatedDurationSeconds: 120,
      unknownDurationTrackCount: 0,
      batchOutstanding: false,
    });
  });

  it.each(['downloaded', 'rejected', 'deleted'] as const)(
    'holds final-only paid audio until it is %s',
    async (settlement) => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
        status: 'materialized',
      });
      const jobId = await createProviderJob(ctx.db, {
        generationRequestId: requestId,
        normalizedStatus: 'ready',
      });
      const trackId = await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
        status: 'streamable',
        durationSeconds: 300,
      });
      await ctx.db.insert(trackAudioAssets).values({
        trackId,
        assetType: 'provider_final',
        storageProvider: 'provider',
        encryptedSourceUrl: 'fixture-encrypted-final',
        isPlayable: false,
      });
      expect(await getSessionDurationProgress(ctx.db, { ownerUserId, sessionId })).toEqual({
        generatedDurationSeconds: 0,
        unknownDurationTrackCount: 0,
        batchOutstanding: true,
      });
      if (settlement === 'downloaded') {
        await ctx.db.insert(trackAudioAssets).values({
          trackId,
          assetType: 'local_original',
          storageProvider: 'local-fs',
          storageKey: 'duration/final-only',
          isPlayable: true,
        });
        await ctx.db.update(tracks).set({ status: 'ready' }).where(eq(tracks.id, trackId));
      } else {
        await ctx.db.update(tracks).set({ status: settlement }).where(eq(tracks.id, trackId));
      }
      expect(await getSessionDurationProgress(ctx.db, { ownerUserId, sessionId })).toEqual({
        generatedDurationSeconds: settlement === 'downloaded' ? 300 : 0,
        unknownDurationTrackCount: 0,
        batchOutstanding: false,
      });
    },
  );

  it.each([
    {
      pending: 'a given-up final-only Track',
      stream: false,
      givenUp: true,
      duration: 300,
      counted: 0,
    },
    {
      pending: 'a counted stream-playable Track',
      stream: true,
      givenUp: false,
      duration: 300,
      counted: 300,
    },
    {
      pending: 'a given-up stream-only Track of unknown duration',
      stream: true,
      givenUp: true,
      duration: null,
      counted: 0,
    },
  ])(
    'never holds the next batch for $pending awaiting its final download',
    async ({ stream, givenUp, duration, counted }) => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
        status: 'materialized',
      });
      const jobId = await createProviderJob(ctx.db, {
        generationRequestId: requestId,
        normalizedStatus: 'ready',
      });
      const trackId = await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
        status: 'streamable',
        durationSeconds: duration,
        ...(stream ? { streamEncryptedSourceUrl: 'fixture-encrypted-stream' } : {}),
      });
      await ctx.db.insert(trackAudioAssets).values({
        trackId,
        assetType: 'provider_final',
        storageProvider: 'provider',
        encryptedSourceUrl: 'fixture-encrypted-final',
        isPlayable: false,
      });
      const [track] = await ctx.db
        .select({ analyticsId: tracks.analyticsId })
        .from(tracks)
        .where(eq(tracks.id, trackId));
      await ctx.db
        .insert(generationOutputs)
        .values({ ownerUserId, analyticsTrackId: track!.analyticsId, trackId });
      if (givenUp) await recordOutputStorageFailure(ctx.db, trackId);
      expect(await getSessionDurationProgress(ctx.db, { ownerUserId, sessionId })).toEqual({
        generatedDurationSeconds: counted,
        unknownDurationTrackCount: 0,
        batchOutstanding: false,
      });
    },
  );
});
