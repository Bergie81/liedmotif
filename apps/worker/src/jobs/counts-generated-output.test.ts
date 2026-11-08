import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  activitySessions,
  generationOutputs,
  generationRequests,
  getGenerationStats,
  getProviderJobForPoll,
  listeningPreferences,
  markGenerationRequestFailed,
  recordListening,
  tracks,
} from '@liedmotif/db';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import type { NormalizedTrack } from '@liedmotif/providers';
import { runProcessProviderResults } from './process-provider-results';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;
const KEY = randomBytes(32);

const track = (id: string, final = false): NormalizedTrack => ({
  providerTrackId: id,
  title: id,
  streamAudioUrl: `https://cdn.example/stream/${id}`,
  ...(final ? { audioUrl: `https://cdn.example/final/${id}.mp3` } : {}),
});

describeIfDb('provider results → generated-output stats', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-generated-output-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, [
      'generation_outputs',
      'listening_occurrences',
      'listening_preferences',
      ...GENERATION_FIXTURE_TABLES,
    ]);
  });

  async function providerJob(ownerUserId?: string) {
    const owner = ownerUserId ?? (await createUser(ctx.db));
    const sessionId = await createSession(ctx.db, { ownerUserId: owner });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId: owner,
      activitySessionId: sessionId,
    });
    const jobId = await createProviderJob(ctx.db, {
      generationRequestId: requestId,
      normalizedStatus: 'partially_ready',
    });
    return { job: (await getProviderJobForPoll(ctx.db, jobId))!, ownerUserId: owner, sessionId };
  }

  const deps = () => ({
    db: ctx.db,
    encryptionKey: KEY,
    enqueueDownload: vi.fn(async () => {}),
    enqueueBuffer: vi.fn(async () => {}),
  });

  const stats = (ownerUserId: string, range: '7d' | '30d' | 'all' = '30d', now = new Date()) =>
    getGenerationStats(ctx.db, { ownerUserId, range, now, timezone: 'UTC' });

  it('counts each distinct output once across a partial poll, a repeat, and over-delivery', async () => {
    const { job, ownerUserId } = await providerJob();
    expect(job.requestedTrackCount).toBe(2);

    // Partial: one sibling playable, the other still text-only.
    await runProcessProviderResults(deps(), {
      job,
      tracks: [track('A'), { providerTrackId: 'B' }],
    });
    expect((await stats(ownerUserId)).generatedTracks).toBe(1);

    // Final result delivers one more Track than was requested, then is replayed.
    const full = [track('A', true), track('B', true), track('C', true)];
    await runProcessProviderResults(deps(), { job, tracks: full, complete: true });
    await runProcessProviderResults(deps(), { job, tracks: full, complete: true });

    expect((await stats(ownerUserId)).generatedTracks).toBe(3);
  });
  it('keeps the count when the Tracks and their Session are deleted', async () => {
    const { job, ownerUserId, sessionId } = await providerJob();
    await runProcessProviderResults(deps(), { job, tracks: [track('A'), track('B')] });

    await ctx.db.delete(tracks).where(eq(tracks.ownerUserId, ownerUserId));
    await ctx.db.delete(activitySessions).where(eq(activitySessions.id, sessionId));

    expect((await stats(ownerUserId)).generatedTracks).toBe(2);
  });

  it("reports only the owner's own output, and only what first played inside the period", async () => {
    const mine = await providerJob();
    const theirs = await providerJob();
    await runProcessProviderResults(deps(), { job: mine.job, tracks: [track('A'), track('B')] });
    await runProcessProviderResults(deps(), { job: theirs.job, tracks: [track('C')] });
    const [old] = await runProcessProviderResults(deps(), {
      job: mine.job,
      tracks: [track('A')],
    }).then((r) => r.processedTrackIds);
    await ctx.db
      .update(generationOutputs)
      .set({ firstPlayableAt: sql`now() - interval '40 days'` })
      .where(eq(generationOutputs.trackId, old!));

    expect((await stats(mine.ownerUserId, '30d')).generatedTracks).toBe(1);
    expect((await stats(mine.ownerUserId, 'all')).generatedTracks).toBe(2);
    expect((await stats(theirs.ownerUserId, 'all')).generatedTracks).toBe(1);
  });

  it('counts a failed attempt as an attempt, never as Tracks', async () => {
    const { job, ownerUserId } = await providerJob();
    await markGenerationRequestFailed(ctx.db, {
      generationRequestId: job.generationRequestId,
      errorCode: 'provider_failed',
      errorMessageSafe: 'The music model failed.',
    });
    const other = await providerJob();

    const mine = await stats(ownerUserId);
    expect(mine.failedAttempts).toBe(1);
    expect(mine.generatedTracks).toBe(0);
    expect((await stats(other.ownerUserId)).failedAttempts).toBe(0);

    await ctx.db
      .update(generationRequests)
      .set({ createdAt: sql`now() - interval '40 days'` })
      .where(eq(generationRequests.id, job.generationRequestId));
    expect((await stats(ownerUserId, '30d')).failedAttempts).toBe(0);
    expect((await stats(ownerUserId, 'all')).failedAttempts).toBe(1);
  });

  it('calls output never heard only once listening to it could have been recorded', async () => {
    const { job, ownerUserId, sessionId } = await providerJob();
    const { processedTrackIds } = await runProcessProviderResults(deps(), {
      job,
      tracks: [track('A'), track('B'), track('C')],
    });
    const [heard, legacy] = processedTrackIds;
    // Collection began a day ago; one Track was generated before that.
    await stats(ownerUserId);
    await ctx.db
      .update(listeningPreferences)
      .set({ collectionStartedAt: sql`now() - interval '1 day'` })
      .where(eq(listeningPreferences.ownerUserId, ownerUserId));
    await ctx.db
      .update(generationOutputs)
      .set({ firstPlayableAt: sql`now() - interval '5 days'`, historical: true })
      .where(eq(generationOutputs.trackId, legacy!));

    const now = new Date();
    await recordListening(ctx.db, {
      ownerUserId,
      occurrenceId: '00000000-0000-4000-8000-000000000001',
      trackId: heard!,
      sessionId,
      surface: 'session',
      startedAt: new Date(now.getTime() - 5_000),
      origin: 'auto',
      listenedMs: 5_000,
      playedMs: 5_000,
      clientTimestamp: now,
      endReason: null,
      now,
    });
    // Deleting the heard Track must not turn it into unheard output.
    await ctx.db.delete(tracks).where(eq(tracks.id, heard!));

    expect(await stats(ownerUserId)).toMatchObject({
      generatedTracks: 3,
      historicalTracks: 1,
      neverHeardTracks: 1,
      unknownCoverageTracks: 1,
    });
  });
});
