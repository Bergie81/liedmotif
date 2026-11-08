import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import {
  createGenerationRequest,
  createProviderJob,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
} from './test-fixtures';
import {
  countInFlightTasks,
  countSpendAndInFlightForScopes,
  countTasksInWindow,
  countTasksInWindowByOwner,
  withOwnerGenerationLock,
} from './limits-repo';
import { insertSubmittingGenerationJob } from './submit-repo';
import { ownerScope, POOL_SCOPE } from '../member-pool';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('limits repo', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-limits-repo-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  async function job(
    ownerUserId: string,
    sessionId: string,
    opts: {
      submitState?: 'not_submitted' | 'submitting' | 'submitted' | 'submit_unknown';
      normalizedStatus?: string;
      createdAt?: Date;
      updatedAt?: Date;
    } = {},
  ): Promise<void> {
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    await createProviderJob(ctx.db, {
      generationRequestId: requestId,
      submitState: opts.submitState ?? 'submitted',
      ...(opts.normalizedStatus ? { normalizedStatus: opts.normalizedStatus } : {}),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
    });
  }

  it('counts submitted (spent) tasks in the window and excludes not-submitted + pre-window', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const since = new Date('2026-06-29T00:00:00Z');

    await job(ownerUserId, sessionId, {
      submitState: 'submitted',
      createdAt: new Date('2026-06-29T08:00:00Z'),
    });
    await job(ownerUserId, sessionId, {
      submitState: 'submitted',
      createdAt: new Date('2026-06-29T09:00:00Z'),
    });
    // Never submitted → no spend.
    await job(ownerUserId, sessionId, {
      submitState: 'not_submitted',
      createdAt: new Date('2026-06-29T09:30:00Z'),
    });
    // Submitted but before the window start.
    await job(ownerUserId, sessionId, {
      submitState: 'submitted',
      createdAt: new Date('2026-06-28T23:00:00Z'),
    });

    expect(await countTasksInWindow(ctx.db, { scope: ownerScope(ownerUserId), since })).toBe(2);
  });

  it('scopes the count to the owner', async () => {
    const ownerA = await createUser(ctx.db);
    const ownerB = await createUser(ctx.db);
    const sessionA = await createSession(ctx.db, { ownerUserId: ownerA });
    const sessionB = await createSession(ctx.db, { ownerUserId: ownerB });
    const since = new Date('2026-06-29T00:00:00Z');
    await job(ownerA, sessionA, { createdAt: new Date('2026-06-29T08:00:00Z') });
    await job(ownerB, sessionB, { createdAt: new Date('2026-06-29T08:00:00Z') });

    expect(await countTasksInWindow(ctx.db, { scope: ownerScope(ownerA), since })).toBe(1);
  });

  it('counts in-flight provider jobs for concurrency', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const phantomSubmitCutoff = new Date('2026-06-29T11:45:00Z');
    await job(ownerUserId, sessionId, { normalizedStatus: 'processing' });
    await job(ownerUserId, sessionId, { normalizedStatus: 'submitted' });
    await job(ownerUserId, sessionId, { normalizedStatus: 'ready' }); // done → not in flight

    expect(
      await countInFlightTasks(ctx.db, { scope: ownerScope(ownerUserId), phantomSubmitCutoff }),
    ).toBe(2);
  });

  it('holds a concurrency slot through the paid-call window (queued) and for a recent uncertain submit', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const phantomSubmitCutoff = new Date('2026-06-29T11:45:00Z');
    const young = new Date('2026-06-29T11:50:00Z'); // after the cutoff → held
    // Mid-submit: the paid HTTP call is in flight right now (no task id yet).
    await job(ownerUserId, sessionId, {
      submitState: 'submitting',
      normalizedStatus: 'queued',
      updatedAt: young,
    });
    // Uncertain paid submit, parked — may have charged, so its slot is held.
    await job(ownerUserId, sessionId, {
      submitState: 'submit_unknown',
      normalizedStatus: 'submit_unknown',
      updatedAt: young,
    });

    expect(
      await countInFlightTasks(ctx.db, { scope: ownerScope(ownerUserId), phantomSubmitCutoff }),
    ).toBe(2);
  });

  it('releases phantom slots at the cutoff so a dead submit cannot block the owner forever', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const phantomSubmitCutoff = new Date('2026-06-29T11:45:00Z');
    // Strictly-greater bound: exactly AT the cutoff is already released.
    await job(ownerUserId, sessionId, {
      submitState: 'submitting',
      normalizedStatus: 'queued',
      updatedAt: phantomSubmitCutoff,
    });
    await job(ownerUserId, sessionId, {
      submitState: 'submit_unknown',
      normalizedStatus: 'submit_unknown',
      updatedAt: new Date('2026-06-29T11:00:00Z'),
    });
    // LIVE statuses are never age-bounded — the poll loop owns them.
    await job(ownerUserId, sessionId, {
      normalizedStatus: 'processing',
      updatedAt: new Date('2026-06-29T10:00:00Z'),
    });

    expect(
      await countInFlightTasks(ctx.db, { scope: ownerScope(ownerUserId), phantomSubmitCutoff }),
    ).toBe(1);
  });

  it('countTasksInWindowByOwner matches per-owner single-scope counts', async () => {
    const ownerA = await createUser(ctx.db);
    const ownerB = await createUser(ctx.db);
    const ownerIdle = await createUser(ctx.db);
    const sessionA = await createSession(ctx.db, { ownerUserId: ownerA });
    const sessionB = await createSession(ctx.db, { ownerUserId: ownerB });
    const since = new Date('2026-06-29T00:00:00Z');

    await job(ownerA, sessionA, { createdAt: new Date('2026-06-29T08:00:00Z') });
    await job(ownerA, sessionA, { createdAt: new Date('2026-06-29T09:00:00Z') });
    await job(ownerA, sessionA, {
      submitState: 'not_submitted',
      createdAt: new Date('2026-06-29T09:30:00Z'),
    });
    await job(ownerB, sessionB, { createdAt: new Date('2026-06-29T08:00:00Z') });
    await job(ownerB, sessionB, { createdAt: new Date('2026-06-28T23:00:00Z') });

    const byOwner = await countTasksInWindowByOwner(ctx.db, { since });
    for (const owner of [ownerA, ownerB, ownerIdle]) {
      expect(byOwner.get(owner) ?? 0).toBe(
        await countTasksInWindow(ctx.db, { scope: ownerScope(owner), since }),
      );
    }
  });

  it('countSpendAndInFlightForScopes matches the standalone counts per scope', async () => {
    const ownerA = await createUser(ctx.db);
    const ownerB = await createUser(ctx.db);
    const sessionA = await createSession(ctx.db, { ownerUserId: ownerA });
    const sessionB = await createSession(ctx.db, { ownerUserId: ownerB });
    const dayStart = new Date('2026-06-29T00:00:00Z');
    const monthStart = new Date('2026-06-01T00:00:00Z');
    const phantomSubmitCutoff = new Date('2026-06-29T11:45:00Z');

    // Spread across windows, states, and owners so every aggregate differs.
    await job(ownerA, sessionA, { createdAt: new Date('2026-06-29T08:00:00Z') });
    await job(ownerA, sessionA, { createdAt: new Date('2026-06-10T08:00:00Z') });
    await job(ownerA, sessionA, {
      submitState: 'not_submitted',
      createdAt: new Date('2026-06-29T09:00:00Z'),
    });
    await job(ownerA, sessionA, {
      normalizedStatus: 'processing',
      createdAt: new Date('2026-05-15T08:00:00Z'),
    });
    await job(ownerB, sessionB, { createdAt: new Date('2026-06-29T10:00:00Z') });
    await job(ownerB, sessionB, {
      submitState: 'submit_unknown',
      normalizedStatus: 'submit_unknown',
      createdAt: new Date('2026-06-29T11:00:00Z'),
      updatedAt: new Date('2026-06-29T11:50:00Z'),
    });

    const scopes = [ownerScope(ownerA), POOL_SCOPE] as const;
    const combined = await countSpendAndInFlightForScopes(ctx.db, {
      scopes: scopes.map((spend) => ({ spend, since: [dayStart, monthStart] })),
      phantomSubmitCutoff,
    });
    for (const [index, scope] of scopes.entries()) {
      expect(combined[index]).toEqual({
        tasksUsed: [
          await countTasksInWindow(ctx.db, { scope, since: dayStart }),
          await countTasksInWindow(ctx.db, { scope, since: monthStart }),
        ],
        inFlightTasks: await countInFlightTasks(ctx.db, { scope, phantomSubmitCutoff }),
      });
    }
  });

  it('withOwnerGenerationLock serializes concurrent count-check-insert sequences', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const since = new Date('2026-06-29T00:00:00Z');

    // Each attempt is the buffer tick's money sequence in miniature: count the
    // spend, dwell (so unlocked attempts would overlap and BOTH read 0), then
    // claim the last budgeted task. With the per-owner lock, exactly one may win.
    const attempt = (): Promise<'submitted' | 'blocked'> =>
      withOwnerGenerationLock(ctx.db, ownerUserId, async (tx) => {
        const used = await countTasksInWindow(tx, { scope: ownerScope(ownerUserId), since });
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (used > 0) {
          return 'blocked';
        }
        await insertSubmittingGenerationJob(tx, {
          ownerUserId,
          activitySessionId: sessionId,
          providerKey: 'mock',
        });
        return 'submitted';
      });

    const results = await Promise.all([attempt(), attempt()]);
    expect(results.sort()).toEqual(['blocked', 'submitted']);
    expect(await countTasksInWindow(ctx.db, { scope: ownerScope(ownerUserId), since })).toBe(1);
  });
});
