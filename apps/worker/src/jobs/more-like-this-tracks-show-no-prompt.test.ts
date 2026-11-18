import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  defaultUsageLimits,
  generationRequests,
  getReadableTrackDetails,
  providerJobs,
  restyleSession,
} from '@liedmotif/db';
import {
  connectTestDb,
  createSession,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { mockMusicProvider } from '@liedmotif/providers';
import { runEnsureSessionBuffer } from './ensure-session-buffer';

// A More Like This Session starts with no prompt history: nobody typed anything.
// Its Tracks must keep saying so after a later Change Vibe adds a message,
// because they were made before that message existed.

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;
const NOW = new Date('2026-06-29T12:00:00Z');
const SNAPSHOT = { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' };

describeIfDb('Tracks of a Session without a prompt history', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-more-like-this-prompt-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  async function generate(sessionId: string): Promise<void> {
    const result = await runEnsureSessionBuffer(
      {
        db: ctx.db,
        music: mockMusicProvider(),
        now: NOW,
        limits: {
          ...defaultUsageLimits('UTC'),
          dailyGenerationTasks: 100,
          monthlyGenerationTasks: 1000,
          maxConcurrentJobs: 5,
        },
        stallThresholdMs: 24 * 60 * 60 * 1000,
      },
      { sessionId },
    );
    expect(result.action).toBe('generate');
  }

  /** The newest request's Track lands ready, freeing the Session to submit again. */
  async function landTrack(ownerUserId: string, sessionId: string): Promise<string> {
    const [request] = await ctx.db
      .select({ id: generationRequests.id, jobId: providerJobs.id })
      .from(generationRequests)
      .innerJoin(providerJobs, eq(providerJobs.generationRequestId, generationRequests.id))
      .where(eq(generationRequests.activitySessionId, sessionId))
      .orderBy(generationRequests.createdAt)
      .then((rows) => rows.slice(-1));
    await ctx.db
      .update(providerJobs)
      .set({ normalizedStatus: 'ready' })
      .where(eq(providerJobs.id, request!.jobId));
    await ctx.db
      .update(generationRequests)
      .set({ status: 'materialized' })
      .where(eq(generationRequests.id, request!.id));
    return createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: request!.id,
      providerJobId: request!.jobId,
      status: 'ready',
    });
  }

  async function shownPrompt(ownerUserId: string, trackId: string): Promise<string | null> {
    const details = await getReadableTrackDetails(ctx.db, { viewerUserId: ownerUserId, trackId });
    return details!.userPrompt;
  }

  it('show no prompt after a later Change Vibe, while Tracks made after it show its message', async () => {
    const ownerUserId = await createUser(ctx.db);
    // What More Like This creates: a reused snapshot and no prompt history.
    const sessionId = await createSession(ctx.db, { ownerUserId, styleSnapshot: SNAPSHOT });

    await generate(sessionId);
    const firstBatchTrack = await landTrack(ownerUserId, sessionId);

    const changed = await restyleSession(ctx.db, {
      ownerUserId,
      sessionId,
      snapshot: SNAPSHOT,
      includesListener: false,
      userPromptAddition: 'mehr rockiger',
    });
    expect(changed.ok).toBe(true);

    await generate(sessionId);
    const afterChangeTrack = await landTrack(ownerUserId, sessionId);

    expect(await shownPrompt(ownerUserId, firstBatchTrack)).toBeNull();
    expect(await shownPrompt(ownerUserId, afterChangeTrack)).toBe('mehr rockiger');
  });
});
