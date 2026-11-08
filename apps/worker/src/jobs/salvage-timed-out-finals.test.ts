import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  generationRequests,
  insertSubmittingGenerationJob,
  markProviderJobSubmitted,
  providerJobs,
  trackAudioAssets,
  tracks,
  withTransaction,
} from '@liedmotif/db';
import {
  connectTestDb,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import {
  mockMusicProvider,
  type MusicGenerationStatusResult,
  type MusicProvider,
} from '@liedmotif/providers';
import { runPollMusicGeneration } from './poll-music-generation';
import { runSalvageTimedOutFinals } from './salvage-timed-out-finals';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;
const KEY = randomBytes(32);
const PROVIDER = { providerType: 'music' as const, providerKey: 'mock' };

describeIfDb('salvage-timed-out-finals', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-salvage-finals-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  it('attaches a late final to the live Tracks of a timed-out job and enqueues their downloads', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const { requestId, jobId } = await withTransaction(ctx.db, (tx) =>
      insertSubmittingGenerationJob(tx, {
        ownerUserId,
        activitySessionId: sessionId,
        providerKey: 'mock',
        stylePrompt: 'instrumental lofi',
      }),
    );
    await markProviderJobSubmitted(ctx.db, { jobId, providerTaskId: 'slow-task' });

    let upstream: MusicGenerationStatusResult = {
      status: 'text_ready',
      provider: PROVIDER,
      tracks: [
        { providerTrackId: 'A', streamAudioUrl: 'https://cdn.example/s/A' },
        { providerTrackId: 'B', streamAudioUrl: 'https://cdn.example/s/B' },
      ],
    };
    let paidCalls = 0;
    const base = mockMusicProvider();
    const music: MusicProvider = {
      ...base,
      async createGenerationTask(input) {
        paidCalls += 1;
        return base.createGenerationTask(input);
      },
      async getGenerationStatus() {
        return upstream;
      },
    };
    const pollDeps = {
      db: ctx.db,
      music,
      encryptionKey: KEY,
      maxPollAttempts: 2,
      reschedulePoll: vi.fn(async () => {}),
      enqueueDownload: vi.fn(async () => {}),
      enqueueBuffer: vi.fn(async () => {}),
      enqueueProcessResults: vi.fn(async () => {}),
      enqueueSessionCover: vi.fn(async () => {}),
    };
    await runPollMusicGeneration(pollDeps, { providerJobId: jobId });
    const timedOut = await runPollMusicGeneration(pollDeps, { providerJobId: jobId });
    expect(timedOut.outcome).toBe('timed_out');

    const byProviderId = async (providerTrackId: string) => {
      const [row] = await ctx.db
        .select()
        .from(tracks)
        .where(eq(tracks.providerTrackId, providerTrackId));
      return row!;
    };
    const kept = await byProviderId('A');
    const disliked = await byProviderId('B');
    await ctx.db.update(tracks).set({ savedAt: new Date() }).where(eq(tracks.id, kept.id));
    await ctx.db
      .update(tracks)
      .set({ status: 'rejected', dislikedAt: new Date() })
      .where(eq(tracks.id, disliked.id));

    upstream = {
      status: 'complete',
      provider: PROVIDER,
      tracks: ['A', 'B', 'C'].map((id) => ({
        providerTrackId: id,
        streamAudioUrl: `https://cdn.example/s/${id}`,
        audioUrl: `https://cdn.example/f/${id}.mp3`,
        durationSeconds: 181,
      })),
    };
    const salvageDeps = {
      db: ctx.db,
      getMusic: async () => music,
      encryptionKey: KEY,
      enqueueDownload: vi.fn(async () => {}),
      enqueueBuffer: vi.fn(async () => {}),
    };
    const { salvagedTrackIds } = await runSalvageTimedOutFinals(salvageDeps);

    expect(salvagedTrackIds).toEqual([kept.id]);
    expect(salvageDeps.enqueueDownload).toHaveBeenCalledWith(kept.id);
    expect(salvageDeps.enqueueBuffer).toHaveBeenCalledWith(sessionId);
    expect((await byProviderId('A')).durationSeconds).toBe(181);
    const finals = await ctx.db
      .select({ trackId: trackAudioAssets.trackId })
      .from(trackAudioAssets)
      .where(eq(trackAudioAssets.assetType, 'provider_final'));
    expect(finals).toEqual([{ trackId: kept.id }]);
    // Enrichment only: no new Track, the job and its request stay failed, nothing paid.
    expect(await ctx.db.select({ id: tracks.id }).from(tracks)).toHaveLength(2);
    const [job] = await ctx.db.select().from(providerJobs).where(eq(providerJobs.id, jobId));
    expect(job!.normalizedStatus).toBe('failed_final');
    const [request] = await ctx.db
      .select({ status: generationRequests.status })
      .from(generationRequests)
      .where(eq(generationRequests.id, requestId));
    expect(request!.status).toBe('failed');
    expect(paidCalls).toBe(0);

    // A salvaged job leaves the sweep: nothing is read or enqueued again.
    const again = await runSalvageTimedOutFinals(salvageDeps);
    expect(again.salvagedTrackIds).toEqual([]);
    expect(salvageDeps.enqueueDownload).toHaveBeenCalledTimes(1);
  });
});
