// The two-bound Member chokepoint: a Member submit must fit BOTH their
// personal budget and the Members Pool, serialized by the owner lock plus the
// Pool-wide lock (owner → Pool, fixed order). Admin submits stay outside the
// Pool entirely.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activitySessions,
  countTasksInWindow,
  POOL_SCOPE,
  refreshStorageUsage,
  defaultUsageLimits,
  updateMemberLimits,
  updateMembersPool,
  userProfiles,
  type Database,
  type UsageLimits,
} from '@liedmotif/db';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createQueueItem,
  createSession,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import {
  buildProviderDiagnostics,
  mockMusicProvider,
  type MusicGenerationTask,
  type MusicProvider,
} from '@liedmotif/providers';
import { runEnsureSessionBuffer, type EnsureSessionBufferResult } from './ensure-session-buffer';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;
const NOW = new Date('2026-06-29T12:00:00Z');
const NEVER_STALE = 24 * 60 * 60 * 1000;

const FIXTURE_TABLES = [...GENERATION_FIXTURE_TABLES, 'user_settings', 'app_settings'] as const;

function limits(overrides: Partial<UsageLimits> = {}): UsageLimits {
  return {
    ...defaultUsageLimits('UTC'),
    dailyGenerationTasks: 100,
    monthlyGenerationTasks: 1000,
    maxConcurrentJobs: 5,
    ...overrides,
  };
}

function okTask(providerTaskId: string): MusicGenerationTask {
  return {
    providerTaskId,
    status: 'pending',
    provider: { providerType: 'music', providerKey: 'mock', model: 'mock-v1' },
    diagnostics: buildProviderDiagnostics({ rawRequest: {} }),
  };
}

function countingProvider(): { provider: MusicProvider; calls: () => number } {
  const base = mockMusicProvider();
  let calls = 0;
  const provider: MusicProvider = {
    ...base,
    async createGenerationTask() {
      calls += 1;
      return okTask(`member-task-${calls}`);
    },
  };
  return { provider, calls: () => calls };
}

describeIfDb('ensure-session-buffer — Member budgets and the Members Pool', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-buffer-members-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, FIXTURE_TABLES);
  });

  async function createProfiledUser(
    role: 'admin' | 'member',
    opts: { disabledAt?: Date } = {},
  ): Promise<string> {
    const userId = await createUser(ctx.db);
    await ctx.db.insert(userProfiles).values({ userId, role, disabledAt: opts.disabledAt ?? null });
    return userId;
  }

  /** An active session with generation demand for `ownerUserId`. */
  async function generatingSession(ownerUserId: string): Promise<string> {
    return createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' },
    });
  }

  /** One already-spent task for `ownerUserId` inside today's window. */
  async function spendTask(
    ownerUserId: string,
    opts: { normalizedStatus?: string } = {},
  ): Promise<void> {
    const requestId = await createGenerationRequest(ctx.db, { ownerUserId });
    await createProviderJob(ctx.db, {
      generationRequestId: requestId,
      submitState: 'submitted',
      normalizedStatus: opts.normalizedStatus ?? 'ready',
      createdAt: NOW,
    });
  }

  function run(
    sessionId: string,
    provider: MusicProvider,
    instanceLimits: UsageLimits = limits(),
  ): Promise<EnsureSessionBufferResult> {
    return runEnsureSessionBuffer(
      {
        db: ctx.db as Database,
        music: provider,
        now: NOW,
        limits: instanceLimits,
        stallThresholdMs: NEVER_STALE,
      },
      { sessionId },
    );
  }

  /** One ready, queued track ahead of the playhead for `sessionId`. */
  async function queueReadyTrack(ownerUserId: string, sessionId: string): Promise<void> {
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const jobId = await createProviderJob(ctx.db, {
      generationRequestId: requestId,
      submitState: 'submitted',
      normalizedStatus: 'ready',
      createdAt: NOW,
    });
    const trackId = await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      providerTrackId: `ahead-${sessionId}`,
      status: 'ready',
    });
    await createQueueItem(ctx.db, {
      activitySessionId: sessionId,
      trackId,
      generationRequestId: requestId,
      position: 0,
    });
  }

  it('admits a member with headroom in both bounds', async () => {
    const memberId = await createProfiledUser('member');
    const sessionId = await generatingSession(memberId);
    const { provider, calls } = countingProvider();

    const result = await run(sessionId, provider);
    expect(result.action).toBe('generate');
    expect(calls()).toBe(1);
  });

  it('refuses a member with personal headroom when the pool is exhausted, naming the pool', async () => {
    // Another member spent the pool's whole daily budget.
    const other = await createProfiledUser('member');
    await spendTask(other);
    await updateMembersPool(ctx.db as Database, {
      dailyGenerationTasks: 1,
      monthlyGenerationTasks: 10,
    });

    const memberId = await createProfiledUser('member');
    const sessionId = await generatingSession(memberId);
    const { provider, calls } = countingProvider();

    const result = await run(sessionId, provider);
    expect(result.action).toBe('session_repeat');
    expect(result.generationStatus).toBe('repeat_cost_limit');
    expect(result.costLimitScope).toBe('pool');
    expect(calls()).toBe(0);
  });

  it('refuses a member whose own budget is spent while the pool is open, naming the member', async () => {
    const memberId = await createProfiledUser('member');
    await spendTask(memberId);
    await updateMemberLimits(ctx.db as Database, {
      ownerUserId: memberId,
      patch: { dailyGenerationTasks: 1, monthlyGenerationTasks: 10 },
    });
    const sessionId = await generatingSession(memberId);
    const { provider, calls } = countingProvider();

    const result = await run(sessionId, provider);
    expect(result.action).toBe('session_repeat');
    expect(result.generationStatus).toBe('repeat_cost_limit');
    expect(result.costLimitScope).toBe('member');
    expect(calls()).toBe(0);
  });

  it('lets the admin submit while the pool is fully exhausted, and keeps admin jobs out of the pool count', async () => {
    await updateMembersPool(ctx.db as Database, {
      dailyGenerationTasks: 0,
      monthlyGenerationTasks: 0,
    });
    const adminId = await createProfiledUser('admin');
    const sessionId = await generatingSession(adminId);
    const { provider, calls } = countingProvider();

    const result = await run(sessionId, provider);
    expect(result.action).toBe('generate');
    expect(calls()).toBe(1);
    // The admin's freshly-submitted job never enters the pool count.
    expect(await countTasksInWindow(ctx.db, { scope: POOL_SCOPE, since: new Date(0) })).toBe(0);
  });

  it('counts an owner without a profile row (a deleted member) toward the pool', async () => {
    const ghostId = await createUser(ctx.db); // no user_profiles row
    await spendTask(ghostId);
    expect(await countTasksInWindow(ctx.db, { scope: POOL_SCOPE, since: new Date(0) })).toBe(1);
  });

  it('refuses a third concurrent member job at the pool concurrency ceiling', async () => {
    // Two other members hold in-flight jobs (pool maxConcurrentJobs default 2).
    for (let i = 0; i < 2; i += 1) {
      const other = await createProfiledUser('member');
      await spendTask(other, { normalizedStatus: 'processing' });
    }
    const memberId = await createProfiledUser('member');
    const sessionId = await generatingSession(memberId);
    const { provider, calls } = countingProvider();

    const result = await run(sessionId, provider);
    expect(result.action).toBe('wait');
    expect(calls()).toBe(0);
  });

  it('clamps each role by its OWN queued-track ceiling, never the other one', async () => {
    // One ready track ahead: with the shipped ready-ahead target (3) that is
    // still below the watermark, so anything that generates here proves the
    // ceiling was not applied — and applying the WRONG role's ceiling shows up
    // as the opposite verdict on one of the two runs.
    const memberId = await createProfiledUser('member');
    const memberSession = await generatingSession(memberId);
    await queueReadyTrack(memberId, memberSession);
    await updateMemberLimits(ctx.db as Database, {
      ownerUserId: memberId,
      patch: { maxQueuedTracks: 1 },
    });

    const adminId = await createProfiledUser('admin');
    const adminSession = await generatingSession(adminId);
    await queueReadyTrack(adminId, adminSession);

    const { provider, calls } = countingProvider();
    // Instance ceiling wide open: only the Member's own value can hold them back.
    expect((await run(memberSession, provider, limits({ maxQueuedTracks: 10 }))).action).toBe(
      'noop',
    );
    // The Admin is bound by the instance value — the Member's does not reach them.
    expect((await run(adminSession, provider, limits({ maxQueuedTracks: 1 }))).action).toBe('noop');
    expect((await run(adminSession, provider, limits({ maxQueuedTracks: 10 }))).action).toBe(
      'generate',
    );
    expect(calls()).toBe(1);
  });

  it('refuses a disabled member at submit even with budget remaining', async () => {
    const memberId = await createProfiledUser('member', { disabledAt: NOW });
    const sessionId = await generatingSession(memberId);
    const { provider, calls } = countingProvider();

    const result = await run(sessionId, provider);
    expect(result.action).toBe('noop');
    expect(calls()).toBe(0);
  });

  it('admits exactly one of two concurrent member submits racing one pool slot', async () => {
    await updateMembersPool(ctx.db as Database, {
      dailyGenerationTasks: 1,
      monthlyGenerationTasks: 10,
    });
    const memberA = await createProfiledUser('member');
    const memberB = await createProfiledUser('member');
    const sessionA = await generatingSession(memberA);
    const sessionB = await generatingSession(memberB);
    const { provider, calls } = countingProvider();

    // Two different owners hold two different owner locks — only the Pool lock
    // serializes them. This is the race under test.
    const [resultA, resultB] = await Promise.all([
      run(sessionA, provider),
      run(sessionB, provider),
    ]);

    const actions = [resultA.action, resultB.action].sort();
    expect(actions).toEqual(['generate', 'session_repeat']);
    expect(calls()).toBe(1);
    const refused = [resultA, resultB].find((r) => r.action === 'session_repeat')!;
    expect(refused.costLimitScope).toBe('pool');
    expect(await countTasksInWindow(ctx.db, { scope: POOL_SCOPE, since: new Date(0) })).toBe(1);
  });
});

describeIfDb('ensure-session-buffer — Member cost-limit status payload', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-buffer-member-status-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, FIXTURE_TABLES);
  });

  async function createMember(): Promise<string> {
    const userId = await createUser(ctx.db);
    await ctx.db.insert(userProfiles).values({ userId, role: 'member' });
    return userId;
  }

  async function sessionStatusRow(sessionId: string) {
    const [row] = await ctx.db
      .select({
        generationStatus: activitySessions.generationStatus,
        generationStatusScope: activitySessions.generationStatusScope,
        statusMessageSafe: activitySessions.statusMessageSafe,
        status: activitySessions.status,
      })
      .from(activitySessions)
      .where(eq(activitySessions.id, sessionId));
    return row!;
  }

  it('degrades a running member session to Session Repeat naming the personal budget, then auto-resumes at rollover', async () => {
    const memberId = await createMember();
    await updateMemberLimits(ctx.db as Database, {
      ownerUserId: memberId,
      patch: { dailyGenerationTasks: 1, monthlyGenerationTasks: 50 },
    });
    const sessionId = await createSession(ctx.db, {
      ownerUserId: memberId,
      styleSnapshot: { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' },
    });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId: memberId,
      activitySessionId: sessionId,
    });
    await createProviderJob(ctx.db, {
      generationRequestId: requestId,
      submitState: 'submitted',
      normalizedStatus: 'ready',
      createdAt: NOW,
    });

    const { provider } = countingProvider();
    const result = await runEnsureSessionBuffer(
      {
        db: ctx.db as Database,
        music: provider,
        now: NOW,
        limits: limits(),
        stallThresholdMs: NEVER_STALE,
      },
      { sessionId },
    );
    expect(result.action).toBe('session_repeat');
    expect(result.costLimitScope).toBe('member');

    const row = await sessionStatusRow(sessionId);
    expect(row.status).toBe('active'); // never stopped, never paused
    expect(row.generationStatus).toBe('repeat_cost_limit');
    expect(row.generationStatusScope).toBe('member');
    expect(row.statusMessageSafe).toBe(
      'You have used your tracks for now — replaying this session until your budget resets.',
    );

    // Rollover: the next day the same tick generates again and clears the scope.
    const nextDay = new Date('2026-06-30T12:00:00Z');
    const resumed = await runEnsureSessionBuffer(
      {
        db: ctx.db as Database,
        music: provider,
        now: nextDay,
        limits: limits(),
        stallThresholdMs: NEVER_STALE,
      },
      { sessionId },
    );
    expect(resumed.action).toBe('generate');
    const after = await sessionStatusRow(sessionId);
    expect(after.generationStatus).toBe('ok');
    expect(after.generationStatusScope).toBeNull();
  });

  it('names the shared pool when it is the binding bound mid-listen', async () => {
    const other = await createMember();
    const otherRequest = await createGenerationRequest(ctx.db, { ownerUserId: other });
    await createProviderJob(ctx.db, {
      generationRequestId: otherRequest,
      submitState: 'submitted',
      normalizedStatus: 'ready',
      createdAt: NOW,
    });
    await updateMembersPool(ctx.db as Database, {
      dailyGenerationTasks: 1,
      monthlyGenerationTasks: 10,
    });

    const memberId = await createMember();
    const sessionId = await createSession(ctx.db, {
      ownerUserId: memberId,
      styleSnapshot: { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' },
    });
    const { provider } = countingProvider();
    const result = await runEnsureSessionBuffer(
      {
        db: ctx.db as Database,
        music: provider,
        now: NOW,
        limits: limits(),
        stallThresholdMs: NEVER_STALE,
      },
      { sessionId },
    );
    expect(result.action).toBe('session_repeat');
    expect(result.costLimitScope).toBe('pool');

    const row = await sessionStatusRow(sessionId);
    expect(row.generationStatusScope).toBe('pool');
    expect(row.statusMessageSafe).toBe(
      'The shared budget is used up — replaying this session until it resets.',
    );
  });

  it('tells a member blocked by the storage quota who can fix it, never pointing at admin settings', async () => {
    // The quota is instance-wide and only the Admin can raise it (a Member
    // is never sent to an admin-only page).
    const memberId = await createMember();
    const sessionId = await createSession(ctx.db, {
      ownerUserId: memberId,
      styleSnapshot: { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' },
    });
    await refreshStorageUsage(ctx.db as Database);
    const { provider, calls } = countingProvider();

    const result = await runEnsureSessionBuffer(
      {
        db: ctx.db as Database,
        music: provider,
        now: NOW,
        limits: limits({ storageQuotaBytes: 0 }),
        stallThresholdMs: NEVER_STALE,
      },
      { sessionId },
    );
    expect(result.generationStatus).toBe('provider_error');
    expect(calls()).toBe(0);

    const message = (await sessionStatusRow(sessionId)).statusMessageSafe;
    expect(message).toContain('The Admin needs to free space or raise the quota.');
    expect(message).not.toContain('Settings');
  });
  // A One-time budget is one total counted since the Grant.
  // Exhaustion names the member bound with its own `total` window and copy that
  // points at the Admin — there is no rollover to wait for.
  describe('One-time budgets', () => {
    const GRANT = new Date('2026-06-20T00:00:00Z');

    async function oneTimeMember(totalGenerationTasks: number): Promise<string> {
      const memberId = await createMember();
      await updateMemberLimits(ctx.db as Database, {
        ownerUserId: memberId,
        patch: { kind: 'oneTime', totalGenerationTasks, grantedAt: GRANT.toISOString() },
      });
      return memberId;
    }

    async function spendTaskAt(ownerUserId: string, createdAt: Date): Promise<void> {
      const requestId = await createGenerationRequest(ctx.db, { ownerUserId });
      await createProviderJob(ctx.db, {
        generationRequestId: requestId,
        submitState: 'submitted',
        normalizedStatus: 'ready',
        createdAt,
      });
    }

    function tick(sessionId: string, provider: MusicProvider) {
      return runEnsureSessionBuffer(
        {
          db: ctx.db as Database,
          music: provider,
          now: NOW,
          limits: limits(),
          stallThresholdMs: NEVER_STALE,
        },
        { sessionId },
      );
    }

    it('admits while the total has headroom, ignoring the dormant day cap', async () => {
      const memberId = await oneTimeMember(2);
      // The dormant rolling day cap would refuse this; the kind decides.
      await updateMemberLimits(ctx.db as Database, {
        ownerUserId: memberId,
        patch: { dailyGenerationTasks: 0, monthlyGenerationTasks: 0 },
      });
      await spendTaskAt(memberId, NOW);
      const sessionId = await createSession(ctx.db, {
        ownerUserId: memberId,
        styleSnapshot: { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' },
      });
      const { provider, calls } = countingProvider();

      const result = await tick(sessionId, provider);
      expect(result.action).toBe('generate');
      expect(calls()).toBe(1);
    });

    it('degrades to Session Repeat on the total window, naming the member and pointing at the Admin', async () => {
      const adminId = await createUser(ctx.db); // the fixture names every user 'Test Admin'
      await ctx.db.insert(userProfiles).values({ userId: adminId, role: 'admin' });
      const memberId = await oneTimeMember(1);
      await spendTaskAt(memberId, NOW);
      const sessionId = await createSession(ctx.db, {
        ownerUserId: memberId,
        styleSnapshot: { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' },
      });
      const { provider, calls } = countingProvider();

      const result = await tick(sessionId, provider);
      expect(result.action).toBe('session_repeat');
      expect(result.generationStatus).toBe('repeat_cost_limit');
      expect(result.costLimitScope).toBe('member');
      expect(result.costLimitWindow).toBe('total');
      expect(calls()).toBe(0);

      const row = await sessionStatusRow(sessionId);
      expect(row.generationStatusScope).toBe('member');
      expect(row.statusMessageSafe).toBe('Your budget is used up. Ask Test Admin for more.');
    });

    it('counts only spend since the Grant — a switched Member is not born exhausted', async () => {
      const memberId = await oneTimeMember(1);
      await spendTaskAt(memberId, new Date(GRANT.getTime() - 1000));
      const sessionId = await createSession(ctx.db, {
        ownerUserId: memberId,
        styleSnapshot: { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' },
      });
      const { provider, calls } = countingProvider();

      const result = await tick(sessionId, provider);
      expect(result.action).toBe('generate');
      expect(calls()).toBe(1);
    });

    it('is paced by the pool: headroom in the total but an exhausted pool names the pool', async () => {
      const other = await createMember();
      await spendTaskAt(other, NOW);
      await updateMembersPool(ctx.db as Database, {
        dailyGenerationTasks: 1,
        monthlyGenerationTasks: 10,
      });
      const memberId = await oneTimeMember(10);
      const sessionId = await createSession(ctx.db, {
        ownerUserId: memberId,
        styleSnapshot: { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' },
      });
      const { provider, calls } = countingProvider();

      const result = await tick(sessionId, provider);
      expect(result.action).toBe('session_repeat');
      expect(result.costLimitScope).toBe('pool');
      expect(result.costLimitWindow).toBe('day');
      expect(calls()).toBe(0);
      expect((await sessionStatusRow(sessionId)).statusMessageSafe).toBe(
        'The shared budget is used up — replaying this session until it resets.',
      );
    });
  });
});
