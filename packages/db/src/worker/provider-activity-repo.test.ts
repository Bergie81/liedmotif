import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { providerJobs } from '../schema';
import {
  createGenerationRequest,
  createProviderJob,
  createUser,
  GENERATION_FIXTURE_TABLES,
} from '../generation/test-fixtures';
import { getLastProviderPoll, getProviderRetriesToday } from './provider-activity-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('provider activity repo', () => {
  let ctx: TestDb;
  let ownerUserId: string;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-provider-activity-repo-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
    ownerUserId = await createUser(ctx.db);
  });

  async function seedJob(opts: {
    providerStatus?: string | null;
    providerTaskId?: string | null;
    retryCount?: number;
    updatedAt: Date;
  }): Promise<void> {
    const requestId = await createGenerationRequest(ctx.db, { ownerUserId });
    const jobId = await createProviderJob(ctx.db, {
      generationRequestId: requestId,
      providerTaskId: opts.providerTaskId,
    });
    await ctx.db
      .update(providerJobs)
      .set({
        providerStatus: opts.providerStatus ?? null,
        retryCount: opts.retryCount ?? 0,
        updatedAt: opts.updatedAt,
      })
      .where(eq(providerJobs.id, jobId));
  }

  describe('getLastProviderPoll', () => {
    it('returns null when no job has ever reached the provider', async () => {
      expect(await getLastProviderPoll(ctx.db)).toBeNull();
    });

    it('returns the most recently updated submitted job with its provider status', async () => {
      await seedJob({ providerStatus: 'SUCCESS', updatedAt: new Date('2026-07-30T10:00:00Z') });
      await seedJob({
        providerStatus: 'FIRST_SUCCESS',
        updatedAt: new Date('2026-07-30T11:00:00Z'),
      });
      expect(await getLastProviderPoll(ctx.db)).toEqual({
        providerStatus: 'FIRST_SUCCESS',
        at: new Date('2026-07-30T11:00:00Z'),
      });
    });

    it('ignores jobs that never got a provider task id', async () => {
      await seedJob({
        providerStatus: 'SUCCESS',
        providerTaskId: null,
        updatedAt: new Date('2026-07-30T12:00:00Z'),
      });
      expect(await getLastProviderPoll(ctx.db)).toBeNull();
    });

    it('falls back to the normalized status before the first raw status lands', async () => {
      await seedJob({ providerStatus: null, updatedAt: new Date('2026-07-30T10:00:00Z') });
      expect(await getLastProviderPoll(ctx.db)).toEqual({
        // Fixture default: normalizedStatus 'ready'.
        providerStatus: 'ready',
        at: new Date('2026-07-30T10:00:00Z'),
      });
    });
  });

  describe('getProviderRetriesToday', () => {
    it('sums retry counts of jobs touched inside the window and ignores older ones', async () => {
      const dayStart = new Date('2026-07-30T00:00:00Z');
      await seedJob({ retryCount: 2, updatedAt: new Date('2026-07-30T08:00:00Z') });
      await seedJob({ retryCount: 1, updatedAt: new Date('2026-07-30T09:00:00Z') });
      await seedJob({ retryCount: 5, updatedAt: new Date('2026-07-29T23:00:00Z') });
      expect(await getProviderRetriesToday(ctx.db, dayStart)).toBe(3);
    });

    it('returns zero on an empty window', async () => {
      expect(await getProviderRetriesToday(ctx.db, new Date('2026-07-30T00:00:00Z'))).toBe(0);
    });
  });
});
