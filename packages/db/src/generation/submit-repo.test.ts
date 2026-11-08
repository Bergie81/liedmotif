import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildProviderDiagnostics } from '@liedmotif/shared';
import { providerJobs } from '../schema';
import {
  connectTestDb,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';
import { withTransaction } from '../transactions';
import {
  insertSubmittingGenerationJob,
  markProviderJobSubmitted,
  recordProviderTaskIdFailSafe,
} from './submit-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('submit repo diagnostics persistence', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-submit-repo-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  async function submittingJob(): Promise<string> {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const { jobId } = await withTransaction(ctx.db, (tx) =>
      insertSubmittingGenerationJob(tx, {
        ownerUserId,
        activitySessionId: sessionId,
        providerKey: 'mock',
        stylePrompt: 'instrumental lofi, low energy',
      }),
    );
    return jobId;
  }

  async function storedDiagnostics(
    jobId: string,
  ): Promise<{ rawRequest: unknown; rawResponse: unknown }> {
    const [row] = await ctx.db
      .select({ rawRequest: providerJobs.rawRequest, rawResponse: providerJobs.rawResponse })
      .from(providerJobs)
      .where(eq(providerJobs.id, jobId))
      .limit(1);
    return row!;
  }

  it('persists the redacted submit request and response on the normal promote', async () => {
    const jobId = await submittingJob();
    await markProviderJobSubmitted(ctx.db, {
      jobId,
      providerTaskId: 'task-1',
      diagnostics: buildProviderDiagnostics({
        rawRequest: { model: 'V5', personaId: 'voice-1' },
        rawResponse: { code: 200, data: { taskId: 'task-1' } },
      }),
    });
    const stored = await storedDiagnostics(jobId);
    expect(stored.rawRequest).toEqual({ model: 'V5', personaId: 'voice-1' });
    expect(stored.rawResponse).toEqual({ code: 200, data: { taskId: 'task-1' } });
  });

  it('leaves both columns null when the promote carries no diagnostics', async () => {
    const jobId = await submittingJob();
    await markProviderJobSubmitted(ctx.db, { jobId, providerTaskId: 'task-2' });
    const stored = await storedDiagnostics(jobId);
    expect(stored.rawRequest).toBeNull();
    expect(stored.rawResponse).toBeNull();
  });

  it('persists diagnostics on the failure-safe task-id record too', async () => {
    const jobId = await submittingJob();
    await recordProviderTaskIdFailSafe(ctx.db, {
      jobId,
      providerTaskId: 'task-3',
      diagnostics: buildProviderDiagnostics({ rawRequest: { model: 'V5' } }),
    });
    const stored = await storedDiagnostics(jobId);
    expect(stored.rawRequest).toEqual({ model: 'V5' });
    expect(stored.rawResponse).toBeNull();
  });
});
