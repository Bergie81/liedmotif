import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { providerJobs } from '@liedmotif/db';
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
import { runPollDueProviderJobs } from './poll-due-provider-jobs';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;
const NOW = new Date('2026-06-30T12:00:00Z');

describeIfDb('poll-due-provider-jobs (safety-net cron)', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-poll-due-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  async function jobWith(normalizedStatus: string, nextPollAt: Date | null): Promise<string> {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const jobId = await createProviderJob(ctx.db, {
      generationRequestId: requestId,
      normalizedStatus,
    });
    await ctx.db.update(providerJobs).set({ nextPollAt }).where(eq(providerJobs.id, jobId));
    return jobId;
  }

  it('enqueues a poll for each due in-flight job, a recovery for a stranded ready job, and skips the rest', async () => {
    const due = await jobWith('processing', new Date(NOW.getTime() - 1000));
    await jobWith('processing', new Date(NOW.getTime() + 60_000)); // not due
    // Terminal `ready` with zero tracks: never re-polled, but its lost materialization
    // is recovered via `process-provider-results`. Its updatedAt
    // is the insert wall-clock time, which sits inside the recency window around NOW.
    const stranded = await jobWith('ready', new Date(NOW.getTime() - 1000));

    const enqueuePoll = vi.fn(async () => {});
    const enqueueProcessResults = vi.fn(async () => {});
    const result = await runPollDueProviderJobs({
      db: ctx.db,
      now: NOW,
      enqueuePoll,
      enqueueProcessResults,
    });

    expect(result.enqueued).toEqual([due]);
    expect(enqueuePoll).toHaveBeenCalledTimes(1);
    expect(enqueuePoll).toHaveBeenCalledWith(due);

    expect(result.recoveries).toEqual([stranded]);
    expect(enqueueProcessResults).toHaveBeenCalledTimes(1);
    expect(enqueueProcessResults).toHaveBeenCalledWith(stranded);
  });
});
