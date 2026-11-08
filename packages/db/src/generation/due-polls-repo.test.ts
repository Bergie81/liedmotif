import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { providerJobs } from '../schema';
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
} from '../testing';
import { listDuePollJobs, listReadyJobsMissingTracks } from './provider-poll-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;
const NOW = new Date('2026-06-30T12:00:00Z');

describeIfDb('listDuePollJobs (safety-net scan)', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-due-polls-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  async function jobWith(opts: {
    normalizedStatus: string;
    providerTaskId?: string | null;
    nextPollAt?: Date | null;
    lastSubmitAttemptAt?: Date | null;
  }): Promise<string> {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const jobId = await createProviderJob(ctx.db, {
      generationRequestId: requestId,
      normalizedStatus: opts.normalizedStatus,
      // undefined → fixture mints a unique task id; null → genuinely no task id.
      ...(opts.providerTaskId !== undefined ? { providerTaskId: opts.providerTaskId } : {}),
    });
    await ctx.db
      .update(providerJobs)
      .set({
        nextPollAt: opts.nextPollAt ?? null,
        lastSubmitAttemptAt: opts.lastSubmitAttemptAt ?? null,
      })
      .where(eq(providerJobs.id, jobId));
    return jobId;
  }

  it('returns in-flight jobs whose next poll is due, and stuck-submitted jobs past the grace', async () => {
    const dueProcessing = await jobWith({
      normalizedStatus: 'processing',
      nextPollAt: new Date(NOW.getTime() - 1000),
    });
    const stuckSubmitted = await jobWith({
      normalizedStatus: 'submitted',
      nextPollAt: null,
      lastSubmitAttemptAt: new Date(NOW.getTime() - 120_000), // 2 min ago, past grace
    });

    // Excluded: future poll, terminal status, no task id, recently-submitted (within grace).
    await jobWith({ normalizedStatus: 'processing', nextPollAt: new Date(NOW.getTime() + 60_000) });
    await jobWith({ normalizedStatus: 'ready', nextPollAt: new Date(NOW.getTime() - 1000) });
    await jobWith({
      normalizedStatus: 'submitted',
      providerTaskId: null,
      nextPollAt: new Date(NOW.getTime() - 1000),
    });
    await jobWith({
      normalizedStatus: 'submitted',
      nextPollAt: null,
      lastSubmitAttemptAt: new Date(NOW.getTime() - 5_000), // 5s ago, within grace
    });

    const due = await listDuePollJobs(ctx.db, { now: NOW, stuckSubmittedGraceMs: 60_000 });
    expect([...due].sort()).toEqual([dueProcessing, stuckSubmitted].sort());
  });

  it('honors the limit (oldest due first)', async () => {
    const older = await jobWith({
      normalizedStatus: 'processing',
      nextPollAt: new Date(NOW.getTime() - 10_000),
    });
    await jobWith({ normalizedStatus: 'processing', nextPollAt: new Date(NOW.getTime() - 1_000) });

    const due = await listDuePollJobs(ctx.db, { now: NOW, limit: 1 });
    expect(due).toEqual([older]);
  });

  // The recovery scan for `ready` jobs whose materialization was
  // lost — entirely or between siblings — with no Graphile retry left to heal them.
  describe('listReadyJobsMissingTracks', () => {
    const RECENT = new Date(NOW.getTime() - 60 * 60_000); // 1h ago (within the 6h window)
    const STALE = new Date(NOW.getTime() - 7 * 60 * 60_000); // 7h ago (outside)

    async function readyJob(opts: {
      updatedAt: Date;
      normalizedStatus?: string;
      providerTaskId?: string | null;
      /** Materialized tracks (the fixture request expects `requestedTrackCount` = 2). */
      withTracks?: number;
    }): Promise<string> {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
      });
      const jobId = await createProviderJob(ctx.db, {
        generationRequestId: requestId,
        normalizedStatus: opts.normalizedStatus ?? 'ready',
        updatedAt: opts.updatedAt,
        ...(opts.providerTaskId !== undefined ? { providerTaskId: opts.providerTaskId } : {}),
      });
      for (let i = 0; i < (opts.withTracks ?? 0); i += 1) {
        await createTrack(ctx.db, {
          ownerUserId,
          generationRequestId: requestId,
          providerJobId: jobId,
        });
      }
      return jobId;
    }

    it('returns recent ready jobs with fewer tracks than requested, and nothing else', async () => {
      const stranded = await readyJob({ updatedAt: RECENT }); // zero of 2
      const partial = await readyJob({ updatedAt: RECENT, withTracks: 1 }); // crash between siblings
      await readyJob({ updatedAt: RECENT, withTracks: 2 }); // fully materialized
      await readyJob({ updatedAt: STALE }); // beyond provider retention — never rescanned
      await readyJob({ updatedAt: RECENT, normalizedStatus: 'processing' }); // not terminal-ready
      await readyJob({ updatedAt: RECENT, providerTaskId: null }); // nothing to re-read

      expect((await listReadyJobsMissingTracks(ctx.db, { now: NOW })).sort()).toEqual(
        [stranded, partial].sort(),
      );
    });

    it('honors the limit (oldest strand first)', async () => {
      const older = await readyJob({ updatedAt: new Date(NOW.getTime() - 2 * 60 * 60_000) });
      await readyJob({ updatedAt: RECENT });
      expect(await listReadyJobsMissingTracks(ctx.db, { now: NOW, limit: 1 })).toEqual([older]);
    });
  });
});
