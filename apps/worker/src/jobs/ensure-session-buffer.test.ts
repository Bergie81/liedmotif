import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  ownerScope,
  activitySessions,
  refreshStorageUsage,
  applyLoopLease,
  countTasksInWindow,
  defaultUsageLimits,
  generationRequests,
  providerCredentials,
  providerJobs,
  tracks,
  updateGenerationSettings,
  usageEvents,
  voiceProfiles,
  withOwnerGenerationLock,
  type StyleSnapshot,
  type Transaction,
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
  rawTrackRow,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import {
  MAX_TRACK_DATA_PROMPT_LENGTH,
  presentGenerationStatus,
  type SessionGenerationStatus,
} from '@liedmotif/shared';
import {
  buildProviderDiagnostics,
  buildSessionStyle,
  buildTrackPrompt,
  compileMusicGenerationInput,
  mockLlmProvider,
  mockMusicProvider,
  ProviderUnbilledError,
  sessionStyleSnapshotSchema,
  type LlmProvider,
  type MusicGenerationInput,
  type MusicGenerationTask,
  type MusicProvider,
  type TrackLyricBriefInput,
  type TrackTitlesInput,
} from '@liedmotif/providers';
import { BLOCK_SIGNAL_COOLDOWNS_MS } from '../controller/buffer';
import { runEnsureSessionBuffer } from './ensure-session-buffer';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;
const music = mockMusicProvider();
const NOW = new Date('2026-06-29T12:00:00Z');

function limits(overrides: Partial<UsageLimits>): UsageLimits {
  return { ...defaultUsageLimits('UTC'), ...overrides };
}

describeIfDb('ensure-session-buffer controller', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-buffer-controller-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    // `provider_credentials` is instance-level (null owner), so truncating
    // `user` does not cascade to it — the refusal tests that store one need it
    // cleared explicitly or it dates every later test's provider config.
    await truncateTables(ctx.pool, [...GENERATION_FIXTURE_TABLES, 'provider_credentials']);
  });

  /** A session with `n` own ready tracks produced by one already-spent task today. */
  async function seedSessionWithOwnTracks(n: number): Promise<{
    ownerUserId: string;
    sessionId: string;
    requestId: string;
    providerJobId: string;
  }> {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' },
    });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    // One submitted (spent) task this window, normalizedStatus ready (not in flight).
    const jobId = await createProviderJob(ctx.db, {
      generationRequestId: requestId,
      submitState: 'submitted',
      normalizedStatus: 'ready',
      createdAt: NOW,
    });
    for (let i = 0; i < n; i += 1) {
      await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
        providerTrackId: `own-${i}`,
        status: 'ready',
      });
    }
    return { ownerUserId, sessionId, requestId, providerJobId: jobId };
  }

  async function sessionStatus(
    sessionId: string,
  ): Promise<{ status: string; generationStatus: string; statusMessageSafe: string | null }> {
    const [row] = await ctx.db
      .select({
        status: activitySessions.status,
        generationStatus: activitySessions.generationStatus,
        statusMessageSafe: activitySessions.statusMessageSafe,
      })
      .from(activitySessions)
      .where(eq(activitySessions.id, sessionId));
    return row!;
  }

  /** A session that has a usable snapshot but no ready tracks → the controller generates. */
  async function freshGeneratingSession(): Promise<{ ownerUserId: string; sessionId: string }> {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' },
    });
    return { ownerUserId, sessionId };
  }

  /** Switch a session to Repeat mode ("Play existing Tracks" — no automatic top-ups). */
  async function switchToRepeatMode(sessionId: string): Promise<void> {
    await ctx.db
      .update(activitySessions)
      .set({ sessionMode: 'repeat' })
      .where(eq(activitySessions.id, sessionId));
  }

  /** All provider-job rows belonging to a session (via its generation requests). */
  async function sessionJobs(
    sessionId: string,
  ): Promise<
    Array<{ submitState: string; normalizedStatus: string; providerTaskId: string | null }>
  > {
    return ctx.db
      .select({
        submitState: providerJobs.submitState,
        normalizedStatus: providerJobs.normalizedStatus,
        providerTaskId: providerJobs.providerTaskId,
      })
      .from(providerJobs)
      .innerJoin(generationRequests, eq(providerJobs.generationRequestId, generationRequests.id))
      .where(eq(generationRequests.activitySessionId, sessionId));
  }

  function okTask(providerTaskId: string): MusicGenerationTask {
    return {
      providerTaskId,
      status: 'pending',
      provider: { providerType: 'music', providerKey: 'mock', model: 'mock-v1' },
      diagnostics: buildProviderDiagnostics({ rawRequest: {} }),
    };
  }

  /** A music provider that counts `createGenerationTask` calls and runs a custom impl. */
  function countingMusicProvider(
    onCreate: (input: MusicGenerationInput, callCount: number) => Promise<MusicGenerationTask>,
  ): { provider: MusicProvider; calls: () => number } {
    const base = mockMusicProvider();
    let calls = 0;
    const provider: MusicProvider = {
      ...base,
      async createGenerationTask(input) {
        calls += 1;
        return onCreate(input, calls);
      },
    };
    return { provider, calls: () => calls };
  }

  /** Limits with ample budget/concurrency so the in-flight buffer count is the only gate. */
  function ampleLimits(): UsageLimits {
    return limits({
      dailyGenerationTasks: 100,
      monthlyGenerationTasks: 1000,
      maxConcurrentJobs: 5,
    });
  }

  it('limited Sessions serialize competing batches and block rerolls and revision fills at the target', async () => {
    const { ownerUserId, sessionId } = await freshGeneratingSession();
    await ctx.db
      .update(activitySessions)
      .set({ targetDurationMinutes: 5 })
      .where(eq(activitySessions.id, sessionId));
    await updateGenerationSettings(ctx.db, { ownerUserId, patch: { bufferAheadTracks: 10 } });
    const counted = countingMusicProvider(async (_, count) => okTask(`duration-${count}`));
    const deps = { db: ctx.db, music: counted.provider, limits: ampleLimits(), now: NOW };
    await Promise.all([
      runEnsureSessionBuffer(deps, { sessionId }),
      runEnsureSessionBuffer(deps, { sessionId }),
    ]);
    expect(counted.calls()).toBe(1);
    const [job] = await ctx.db.select().from(providerJobs);
    await ctx.db
      .update(providerJobs)
      .set({ normalizedStatus: 'ready' })
      .where(eq(providerJobs.id, job!.id));
    await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: job!.generationRequestId,
      providerJobId: job!.id,
      durationSeconds: 300,
      audioStorageKey: 'duration/ready',
    });
    await ctx.db
      .update(activitySessions)
      .set({ styleRevision: 2, vibeSwitchRevision: 2 })
      .where(eq(activitySessions.id, sessionId));
    const repeat = await runEnsureSessionBuffer(deps, { sessionId });
    expect(repeat.action).toBe('session_repeat');
    expect(counted.calls()).toBe(1);
    expect(await sessionStatus(sessionId)).toMatchObject({ status: 'active' });
  });

  it('waits for a ready provider batch to finish materializing all results', async () => {
    const { ownerUserId, sessionId } = await freshGeneratingSession();
    await ctx.db
      .update(activitySessions)
      .set({ targetDurationMinutes: 20 })
      .where(eq(activitySessions.id, sessionId));
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      status: 'awaiting_results',
    });
    const providerJobId = await createProviderJob(ctx.db, {
      generationRequestId: requestId,
      normalizedStatus: 'ready',
      submitState: 'submitted',
    });
    await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId,
      durationSeconds: 120,
      audioStorageKey: 'duration/first',
    });
    const counted = countingMusicProvider(async () => okTask('too-early'));
    await runEnsureSessionBuffer(
      { db: ctx.db, music: counted.provider, limits: ampleLimits(), now: NOW },
      { sessionId },
    );
    expect(counted.calls()).toBe(0);
  });

  it.each([
    [299, 1],
    [300, 0],
    [360, 0],
  ])(
    'compares %i generated seconds to the exact target before buying',
    async (durationSeconds, expectedCalls) => {
      const { ownerUserId, sessionId, requestId, providerJobId } =
        await seedSessionWithOwnTracks(0);
      await ctx.db
        .update(activitySessions)
        .set({ targetDurationMinutes: 5 })
        .where(eq(activitySessions.id, sessionId));
      const kept = await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId,
        durationSeconds,
        audioStorageKey: 'duration/boundary',
      });
      await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId,
        status: 'rejected',
        dislikedAt: NOW,
        rerollPendingAt: NOW,
      });
      const counted = countingMusicProvider(async () => okTask('boundary'));
      const deps = { db: ctx.db, music: counted.provider, limits: ampleLimits(), now: NOW };
      await runEnsureSessionBuffer(deps, { sessionId });
      expect(counted.calls()).toBe(expectedCalls);
      if (durationSeconds === 300) {
        await ctx.db.update(tracks).set({ status: 'deleted' }).where(eq(tracks.id, kept));
        await runEnsureSessionBuffer(deps, { sessionId });
        expect(counted.calls()).toBe(1);
      }
    },
  );

  it('unknown usable duration blocks a fresh purchase below the target', async () => {
    const { ownerUserId, sessionId, requestId, providerJobId } = await seedSessionWithOwnTracks(0);
    await ctx.db
      .update(activitySessions)
      .set({ targetDurationMinutes: 5 })
      .where(eq(activitySessions.id, sessionId));
    await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId,
      audioStorageKey: 'duration/unknown',
    });
    const counted = countingMusicProvider(async () => okTask('must-not-buy'));
    await runEnsureSessionBuffer(
      { db: ctx.db, music: counted.provider, limits: ampleLimits(), now: NOW },
      { sessionId },
    );
    expect(counted.calls()).toBe(0);
  });

  it('a stream-only Track of a failed provider job does not hold a limited Session below its target', async () => {
    const { ownerUserId, sessionId } = await freshGeneratingSession();
    await ctx.db
      .update(activitySessions)
      .set({ targetDurationMinutes: 60 })
      .where(eq(activitySessions.id, sessionId));
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      status: 'failed',
    });
    const providerJobId = await createProviderJob(ctx.db, {
      generationRequestId: requestId,
      normalizedStatus: 'failed_final',
      updatedAt: new Date(NOW.getTime() - 60 * 60_000),
    });
    await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId,
      status: 'streamable',
      streamEncryptedSourceUrl: 'sealed-stream',
    });
    const counted = countingMusicProvider(async () => okTask('after-timeout'));
    const result = await runEnsureSessionBuffer(
      { db: ctx.db, music: counted.provider, limits: ampleLimits(), now: NOW },
      { sessionId },
    );
    expect(result.action).toBe('generate');
    expect(counted.calls()).toBe(1);
  });

  const NEVER_STALE = 24 * 60 * 60 * 1000;

  it('a cost-limited active session loops its own tracks, stays active, and does not re-count replays', async () => {
    const { ownerUserId, sessionId } = await seedSessionWithOwnTracks(3);
    const before = await countTasksInWindow(ctx.db, {
      scope: ownerScope(ownerUserId),
      since: new Date('2026-06-29T00:00:00Z'),
    });
    expect(before).toBe(1);

    const result = await runEnsureSessionBuffer(
      {
        db: ctx.db,
        music,
        now: NOW,
        limits: limits({ dailyGenerationTasks: 1, monthlyGenerationTasks: 100 }),
      },
      { sessionId },
    );

    expect(result.action).toBe('session_repeat');
    expect(result.generationStatus).toBe('repeat_cost_limit');
    expect(result.loopTrackIds).toHaveLength(3); // loops its own tracks

    expect(await sessionStatus(sessionId)).toEqual({
      status: 'active', // never paused or stopped
      generationStatus: 'repeat_cost_limit',
      // Which bound refused is something only this tick knows, so it says so.
      statusMessageSafe: 'Generation limit reached — replaying this session until it resets.',
    });

    // Replays spend nothing: no new provider job, the window count is unchanged.
    const after = await countTasksInWindow(ctx.db, {
      scope: ownerScope(ownerUserId),
      since: new Date('2026-06-29T00:00:00Z'),
    });
    expect(after).toBe(before);
  });

  it('keeps generating past the day cap for an Admin with the Track ceiling off', async () => {
    const { sessionId } = await seedSessionWithOwnTracks(3);

    const result = await runEnsureSessionBuffer(
      {
        db: ctx.db,
        music,
        now: NOW,
        limits: limits({
          trackCeilingEnabled: false,
          dailyGenerationTasks: 1,
          monthlyGenerationTasks: 1,
          maxConcurrentJobs: 5,
        }),
      },
      { sessionId },
    );

    expect(result.action).toBe('generate');
  });

  it('refuses a paid submit once the storage quota has no room for the finals it would buy', async () => {
    // Without this the quota is a displayed number only: generation keeps buying
    // audio whose final download the quota then refuses, so it plays from the
    // provider stream until that expires, and the session reports nothing the
    // admin could act on. "No room" is the download's own reservation size, not
    // "already at the quota": a single MiB left under it fits no final.
    const { ownerUserId, sessionId } = await seedSessionWithOwnTracks(0);
    const { totalBytes } = await refreshStorageUsage(ctx.db);
    const before = await countTasksInWindow(ctx.db, {
      scope: ownerScope(ownerUserId),
      since: new Date('2026-06-29T00:00:00Z'),
    });

    const result = await runEnsureSessionBuffer(
      {
        db: ctx.db,
        music,
        now: NOW,
        limits: limits({ ...ampleLimits(), storageQuotaBytes: totalBytes + 1024 * 1024 }),
      },
      { sessionId },
    );

    expect(result.action).toBe('wait');
    expect(result.generationStatus).toBe('provider_error');
    expect((await sessionStatus(sessionId)).statusMessageSafe).toContain('storage quota');
    expect(
      await countTasksInWindow(ctx.db, {
        scope: ownerScope(ownerUserId),
        since: new Date('2026-06-29T00:00:00Z'),
      }),
    ).toBe(before);
  });

  it('auto-resumes generation (status ok) once the limit window rolls over', async () => {
    const { ownerUserId, sessionId } = await seedSessionWithOwnTracks(3);
    const allTime = new Date('2000-01-01T00:00:00Z');
    const before = await countTasksInWindow(ctx.db, {
      scope: ownerScope(ownerUserId),
      since: allTime,
    });
    expect(before).toBe(1);

    // Next day: the prior spent task falls into yesterday's window, so today's
    // count is 0 again under the SAME window math → assertWithinLimits passes.
    const nextDay = new Date('2026-06-30T09:00:00Z');
    const result = await runEnsureSessionBuffer(
      {
        db: ctx.db,
        music,
        now: nextDay,
        limits: limits({ dailyGenerationTasks: 1, monthlyGenerationTasks: 100 }),
      },
      { sessionId },
    );

    expect(result.action).toBe('generate');
    expect(result.generationStatus).toBe('ok');
    expect(result.submittedTaskId).toBeTruthy();
    expect((await sessionStatus(sessionId)).generationStatus).toBe('ok');

    // Generation resumed → exactly one fresh task was spent.
    const after = await countTasksInWindow(ctx.db, {
      scope: ownerScope(ownerUserId),
      since: allTime,
    });
    expect(after).toBe(before + 1);
  });

  it('writes a provider block status (no lifecycle change) without spending', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: { stylePrompt: 'instrumental', bpm: 100, key: 'C major' },
    });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    await createProviderJob(ctx.db, {
      generationRequestId: requestId,
      submitState: 'submitted',
      normalizedStatus: 'blocked_by_provider_credits',
      createdAt: NOW,
    });

    const before = await countTasksInWindow(ctx.db, {
      scope: ownerScope(ownerUserId),
      since: new Date('2026-06-29T00:00:00Z'),
    });
    const result = await runEnsureSessionBuffer(
      {
        db: ctx.db,
        music,
        now: NOW,
        limits: limits({ dailyGenerationTasks: 100, monthlyGenerationTasks: 1000 }),
      },
      { sessionId },
    );

    expect(result.action).toBe('noop');
    expect(result.generationStatus).toBe('provider_credits');
    const blocked = await sessionStatus(sessionId);
    expect(blocked.generationStatus).toBe('provider_credits');
    // A generic block carries no server message: the status alone says what
    // happened, and the player owns the copy that names it.
    expect(blocked.statusMessageSafe).toBeNull();
    const after = await countTasksInWindow(ctx.db, {
      scope: ownerScope(ownerUserId),
      since: new Date('2026-06-29T00:00:00Z'),
    });
    expect(after).toBe(before); // no new spend
  });

  it('is a no-op for a stopped session (excluded from buffer work)', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
    const result = await runEnsureSessionBuffer(
      { db: ctx.db, music, now: NOW, limits: limits({}) },
      { sessionId },
    );
    expect(result.action).toBe('noop');
  });

  // Crash-safe paid submit (exactly-once). The provider call costs real money; a
  // throw before the task id is durably persisted must never let a Graphile retry
  // issue a second paid call or orphan/duplicate the job.
  it('parks an uncertain submit when the provider call throws and never re-submits on retry', async () => {
    const { sessionId } = await freshGeneratingSession();
    const { provider, calls } = countingMusicProvider(async () => {
      throw new Error('network blip mid-submit');
    });
    const deps = {
      db: ctx.db,
      music: provider,
      now: NOW,
      limits: ampleLimits(),
      stallThresholdMs: NEVER_STALE,
    };

    // First run: the paid call throws → the SAME row is parked, the error propagates.
    await expect(runEnsureSessionBuffer(deps, { sessionId })).rejects.toThrow('network blip');
    expect(calls()).toBe(1);

    const afterFirst = await sessionJobs(sessionId);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.submitState).toBe('submit_unknown');
    expect(afterFirst[0]!.normalizedStatus).toBe('submit_unknown');
    expect(afterFirst[0]!.providerTaskId).toBeNull();

    // Retry (Graphile re-runs the job): the provider is NOT called again and no
    // second/orphan provider job is created — the parked job holds the buffer slot.
    const retry = await runEnsureSessionBuffer(deps, { sessionId });
    expect(retry.action).toBe('noop');
    expect(calls()).toBe(1);
    expect(await sessionJobs(sessionId)).toHaveLength(1);
  });

  // Spend classification. A definitive provider refusal charges
  // nothing, so counting it would let an outage burn the whole budget window and
  // degrade every session to `repeat_cost_limit` with zero tracks generated. The
  // refusal's block signal stops the Graphile retry of this same tick from
  // re-dialing the provider.
  it('does not spend the budget window on a definitively rejected submit', async () => {
    const { ownerUserId, sessionId } = await freshGeneratingSession();
    const { provider, calls } = countingMusicProvider(async () => {
      throw new ProviderUnbilledError('The music provider rejected the generation request.');
    });
    const deps = {
      db: ctx.db,
      music: provider,
      now: NOW,
      limits: ampleLimits(),
      stallThresholdMs: NEVER_STALE,
    };
    const spend = () =>
      countTasksInWindow(ctx.db, { scope: ownerScope(ownerUserId), since: new Date(0) });

    await expect(runEnsureSessionBuffer(deps, { sessionId })).rejects.toThrow();
    expect(calls()).toBe(1);

    const parked = await sessionJobs(sessionId);
    expect(parked).toHaveLength(1);
    expect(parked[0]!.submitState).toBe('submit_rejected');
    expect(parked[0]!.normalizedStatus).toBe('submit_rejected');
    expect(parked[0]!.providerTaskId).toBeNull();
    expect(await spend()).toBe(0);
    // Nothing was billed, so nothing is ledgered.
    expect(
      await ctx.db.select().from(usageEvents).where(eq(usageEvents.userId, ownerUserId)),
    ).toHaveLength(0);

    // Money safety: the retry is blocked by the refusal and never issues a
    // second call.
    const retry = await runEnsureSessionBuffer(deps, { sessionId });
    expect(retry.action).toBe('noop');
    expect(calls()).toBe(1);
    expect(await sessionJobs(sessionId)).toHaveLength(1);
  });

  // Out of credits, maintenance and rate limits clear without any change to the
  // request, so they block on a clock — still unbilled — while every other
  // refusal stays terminal until the prompt or the provider setup changes.
  /** A Session whose first submit the provider refuses (unbilled) with `refusal`. */
  async function refusedFirstSubmit(
    refusal?: 'insufficient_credit' | 'provider_unavailable' | 'rate_limited',
    mode: 'keep_going' | 'repeat' = 'keep_going',
  ) {
    const { ownerUserId, sessionId } = await freshGeneratingSession();
    if (mode === 'repeat') await switchToRepeatMode(sessionId);
    const { provider, calls } = countingMusicProvider(async (_input, n) => {
      if (n > 1) return okTask(`after-refusal-${n}`);
      throw new ProviderUnbilledError(
        'The music provider rejected the generation request.',
        undefined,
        refusal,
      );
    });
    const deps = {
      db: ctx.db,
      music: provider,
      now: NOW,
      limits: ampleLimits(),
      stallThresholdMs: NEVER_STALE,
    };
    await expect(runEnsureSessionBuffer(deps, { sessionId })).rejects.toThrow();
    expect(calls()).toBe(1);
    expect(
      await countTasksInWindow(ctx.db, { scope: ownerScope(ownerUserId), since: new Date(0) }),
    ).toBe(0);
    expect(
      await ctx.db.select().from(usageEvents).where(eq(usageEvents.userId, ownerUserId)),
    ).toHaveLength(0);
    /** Date the parked job `ageMs` before NOW, as if that long had passed since the refusal. */
    const ageRefusal = (ageMs: number) =>
      ctx.db
        .update(providerJobs)
        .set({ updatedAt: new Date(NOW.getTime() - ageMs) })
        .where(
          inArray(
            providerJobs.generationRequestId,
            ctx.db
              .select({ id: generationRequests.id })
              .from(generationRequests)
              .where(eq(generationRequests.activitySessionId, sessionId)),
          ),
        );
    const tick = () => runEnsureSessionBuffer(deps, { sessionId });
    return { sessionId, calls, ageRefusal, tick };
  }

  /** The banner body the player renders for `status`, with and without ready Tracks. */
  async function shownCopy(sessionId: string, status: SessionGenerationStatus) {
    const stored = await statusMessage(sessionId);
    return [
      presentGenerationStatus(status, stored).message,
      presentGenerationStatus(status, stored, null, {
        readyTrackCount: 0,
        generationInFlight: false,
      }).message,
    ];
  }

  it('an out-of-credits submit blocks as provider credits and generates again after the cooldown', async () => {
    const { sessionId, calls, ageRefusal, tick } = await refusedFirstSubmit('insufficient_credit');
    const parked = await sessionJobs(sessionId);
    expect(parked).toHaveLength(1);
    expect(parked[0]!.submitState).toBe('submit_rejected');
    expect(parked[0]!.normalizedStatus).toBe('blocked_by_provider_credits');
    expect(parked[0]!.providerTaskId).toBeNull();

    await ageRefusal(BLOCK_SIGNAL_COOLDOWNS_MS.provider_credits - 60_000);
    const blocked = await tick();
    expect(blocked.action).toBe('noop');
    expect(blocked.generationStatus).toBe('provider_credits');
    // The player's own credits copy, not the change-the-prompt refusal copy.
    expect(await statusMessage(sessionId)).toBeNull();
    for (const shown of await shownCopy(sessionId, 'provider_credits')) {
      expect(shown).toMatch(/out of credits.*Admin tops it up/);
      expect(shown).not.toMatch(/Change Vibe|prompt/);
    }
    expect(calls()).toBe(1);

    await ageRefusal(BLOCK_SIGNAL_COOLDOWNS_MS.provider_credits + 60_000);
    const resumed = await tick();
    expect(resumed.action).toBe('generate');
    expect(resumed.submittedTaskId).toBe('after-refusal-2');
    expect(calls()).toBe(2);
  });

  it('a maintenance submit recovers after its cooldown', async () => {
    const { sessionId, calls, ageRefusal, tick } = await refusedFirstSubmit('provider_unavailable');
    const parked = await sessionJobs(sessionId);
    expect(parked[0]!.submitState).toBe('submit_rejected');
    expect(parked[0]!.normalizedStatus).toBe('failed_final');

    await ageRefusal(BLOCK_SIGNAL_COOLDOWNS_MS.provider_error - 60_000);
    const blocked = await tick();
    expect(blocked.action).toBe('noop');
    // Self-clearing: an empty Session waiting it out is never offered as a dead end.
    expect(blocked.generationStatus).toBe('provider_rate_limited');
    for (const shown of await shownCopy(sessionId, 'provider_rate_limited')) {
      // The first fill is not listener-gated, so it retries on its own.
      expect(shown).toMatch(/under maintenance.*automatically/);
      expect(shown).not.toMatch(/Change Vibe|prompt|[Pp]ress play/);
    }
    expect(
      presentGenerationStatus('provider_rate_limited', await statusMessage(sessionId), null, {
        readyTrackCount: 0,
        generationInFlight: false,
      }).isStuck,
    ).toBe(false);
    expect(calls()).toBe(1);

    // The cooldown outlasts the Start's listener window, and nothing played.
    await ctx.db
      .update(activitySessions)
      .set({ startedAt: new Date(NOW.getTime() - BLOCK_SIGNAL_COOLDOWNS_MS.provider_error) })
      .where(eq(activitySessions.id, sessionId));
    await ageRefusal(BLOCK_SIGNAL_COOLDOWNS_MS.provider_error + 60_000);
    expect((await tick()).action).toBe('generate');
    expect(calls()).toBe(2);
    // The recovered tick leaves no maintenance copy behind.
    expect(await statusMessage(sessionId)).toBeNull();
  });

  // Suno's 405 (rate limit) and 430 (call frequency) both arrive as `rate_limited`.
  it('a rate-limited submit recovers after its short cooldown', async () => {
    const { sessionId, calls, ageRefusal, tick } = await refusedFirstSubmit('rate_limited');
    const parked = await sessionJobs(sessionId);
    expect(parked).toHaveLength(1);
    expect(parked[0]!.submitState).toBe('submit_rejected');
    expect(parked[0]!.normalizedStatus).toBe('provider_rate_limited');
    expect(parked[0]!.providerTaskId).toBeNull();

    await ageRefusal(BLOCK_SIGNAL_COOLDOWNS_MS.provider_rate_limited - 10_000);
    const blocked = await tick();
    expect(blocked.action).toBe('noop');
    expect(blocked.generationStatus).toBe('provider_rate_limited');
    for (const shown of await shownCopy(sessionId, 'provider_rate_limited')) {
      expect(shown).toMatch(/busy.*resumes automatically in a few minutes/);
      expect(shown).not.toMatch(/Change Vibe|prompt/);
    }
    expect(calls()).toBe(1);

    await ageRefusal(BLOCK_SIGNAL_COOLDOWNS_MS.provider_rate_limited + 10_000);
    const resumed = await tick();
    expect(resumed.action).toBe('generate');
    expect(resumed.submittedTaskId).toBe('after-refusal-2');
    expect(calls()).toBe(2);
    expect(await sessionJobs(sessionId)).toHaveLength(2);
  });

  // An unbilled refusal bought no batch, so it never uses up the one batch a
  // Repeat Session — or a Change Vibe revision in Repeat — is owed.
  it.each(['insufficient_credit', 'provider_unavailable', 'rate_limited'] as const)(
    'a Repeat Session whose first batch was refused unbilled (%s) gets that one batch after the cooldown',
    async (refusal) => {
      const { calls, ageRefusal, tick } = await refusedFirstSubmit(refusal, 'repeat');

      await ageRefusal(24 * 60 * 60_000);
      expect((await tick()).action).toBe('generate');
      expect(calls()).toBe(2);

      // The batch is the one Repeat is owed — nothing after it.
      expect((await tick()).action).toBe('noop');
      expect(calls()).toBe(2);
    },
  );

  it('a Change Vibe revision refused unbilled in Repeat gets its initial fill after the cooldown', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      sessionMode: 'repeat',
      styleSnapshot: { stylePrompt: 'ambient piano', bpm: 70, key: 'C major' },
    });
    await ctx.db
      .update(activitySessions)
      .set({ styleRevision: 2, vibeSwitchRevision: null })
      .where(eq(activitySessions.id, sessionId));
    const oldRequestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      styleRevision: 1,
    });
    const oldJobId = await createProviderJob(ctx.db, {
      generationRequestId: oldRequestId,
      submitState: 'submitted',
      normalizedStatus: 'ready',
      createdAt: NOW,
    });
    const oldTrackId = await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: oldRequestId,
      providerJobId: oldJobId,
      providerTrackId: 'old-vibe',
      status: 'ready',
    });
    await createQueueItem(ctx.db, {
      activitySessionId: sessionId,
      trackId: oldTrackId,
      generationRequestId: oldRequestId,
      position: 0,
      state: 'queued',
    });
    const { provider, calls } = countingMusicProvider(async (_input, n) => {
      if (n > 1) return okTask(`new-vibe-${n}`);
      throw new ProviderUnbilledError('Rate limited.', undefined, 'rate_limited');
    });
    const deps = {
      db: ctx.db,
      music: provider,
      now: NOW,
      limits: ampleLimits(),
      stallThresholdMs: NEVER_STALE,
    };
    await expect(runEnsureSessionBuffer(deps, { sessionId })).rejects.toThrow();
    expect(calls()).toBe(1);

    await ctx.db
      .update(providerJobs)
      .set({ updatedAt: new Date(NOW.getTime() - 24 * 60 * 60_000) })
      .where(eq(providerJobs.submitState, 'submit_rejected'));
    const resumed = await runEnsureSessionBuffer(deps, { sessionId });
    expect(resumed.action).toBe('generate');
    expect(calls()).toBe(2);
    const revisions = (await sessionRequests(sessionId)).map((r) => r.styleRevision);
    expect(revisions.sort()).toEqual([1, 2, 2]);
  });

  it.each(['keep_going', 'repeat'] as const)(
    'any other definitive refusal stays terminal however long it sits (%s)',
    async (mode) => {
      const { sessionId, calls, ageRefusal, tick } = await refusedFirstSubmit(undefined, mode);
      expect((await sessionJobs(sessionId))[0]!.normalizedStatus).toBe('submit_rejected');

      await ageRefusal(24 * 60 * 60_000);
      const blocked = await tick();
      expect(blocked.action).toBe('noop');
      expect(blocked.generationStatus).toBe('provider_error');
      expect(await statusMessage(sessionId)).toContain('refused');
      expect(calls()).toBe(1);
    },
  );

  it('still spends the window on an AMBIGUOUS submit failure', async () => {
    const { ownerUserId, sessionId } = await freshGeneratingSession();
    const { provider } = countingMusicProvider(async () => {
      throw new Error('socket hang up');
    });
    await expect(
      runEnsureSessionBuffer(
        {
          db: ctx.db,
          music: provider,
          now: NOW,
          limits: ampleLimits(),
          stallThresholdMs: NEVER_STALE,
        },
        { sessionId },
      ),
    ).rejects.toThrow();
    expect(
      await countTasksInWindow(ctx.db, { scope: ownerScope(ownerUserId), since: new Date(0) }),
    ).toBe(1);
  });

  it('parks the job when the post-call task-id persist fails and never re-submits on retry', async () => {
    const { ownerUserId, sessionId } = await freshGeneratingSession();
    // Pre-seed an unrelated request that already owns the task id the provider will
    // return, so promoting our job collides on the unique (provider_key, task_id)
    // index: the paid call returned, but persisting its task id fails.
    const otherReq = await createGenerationRequest(ctx.db, { ownerUserId });
    const DUP = 'mock-dup-task';
    await createProviderJob(ctx.db, {
      generationRequestId: otherReq,
      providerTaskId: DUP,
      submitState: 'submitted',
      normalizedStatus: 'processing',
    });

    const { provider, calls } = countingMusicProvider(async () => okTask(DUP));
    const deps = {
      db: ctx.db,
      music: provider,
      now: NOW,
      limits: ampleLimits(),
      stallThresholdMs: NEVER_STALE,
    };

    await expect(runEnsureSessionBuffer(deps, { sessionId })).rejects.toBeTruthy();
    expect(calls()).toBe(1);

    const afterFirst = await sessionJobs(sessionId);
    expect(afterFirst).toHaveLength(1);
    // The duplicate task id can't be stored → the row is parked as submit_unknown,
    // counted toward spend + in-flight, so a retry can never double-charge.
    expect(afterFirst[0]!.submitState).toBe('submit_unknown');

    const retry = await runEnsureSessionBuffer(deps, { sessionId });
    expect(retry.action).toBe('noop');
    expect(calls()).toBe(1);
    expect(await sessionJobs(sessionId)).toHaveLength(1);
  });

  it('schedules the first poll for the freshly submitted provider job', async () => {
    const { sessionId } = await freshGeneratingSession();
    const { provider } = countingMusicProvider(async () => okTask('mock-poll-1'));
    const enqueuePoll = vi.fn(async () => {});

    const result = await runEnsureSessionBuffer(
      {
        db: ctx.db,
        music: provider,
        now: NOW,
        limits: ampleLimits(),
        stallThresholdMs: NEVER_STALE,
        enqueuePoll,
      },
      { sessionId },
    );

    expect(result.action).toBe('generate');
    expect(result.submittedProviderJobId).toBeTruthy();
    expect(enqueuePoll).toHaveBeenCalledTimes(1);
    expect(enqueuePoll).toHaveBeenCalledWith(result.submittedProviderJobId);
  });

  it('persists the submit diagnostics (redacted request + response) on the provider job', async () => {
    const { sessionId } = await freshGeneratingSession();
    const { provider } = countingMusicProvider(async () => ({
      ...okTask('mock-diag-1'),
      diagnostics: buildProviderDiagnostics({
        rawRequest: { model: 'V5', prompt: 'lofi' },
        rawResponse: { code: 200, data: { taskId: 'mock-diag-1' } },
      }),
    }));

    const result = await runEnsureSessionBuffer(
      {
        db: ctx.db,
        music: provider,
        now: NOW,
        limits: ampleLimits(),
        stallThresholdMs: NEVER_STALE,
      },
      { sessionId },
    );

    expect(result.action).toBe('generate');
    const [job] = await ctx.db
      .select({ rawRequest: providerJobs.rawRequest, rawResponse: providerJobs.rawResponse })
      .from(providerJobs)
      .where(eq(providerJobs.id, result.submittedProviderJobId!));
    expect(job!.rawRequest).toEqual({ model: 'V5', prompt: 'lofi' });
    expect(job!.rawResponse).toEqual({ code: 200, data: { taskId: 'mock-diag-1' } });
  });

  it('records the request index as the request titleSeed (distinct sibling titles downstream)', async () => {
    const { sessionId } = await freshGeneratingSession();
    const { provider } = countingMusicProvider(async () => okTask('mock-seed-1'));
    const result = await runEnsureSessionBuffer(
      {
        db: ctx.db,
        music: provider,
        now: NOW,
        limits: ampleLimits(),
        stallThresholdMs: NEVER_STALE,
      },
      { sessionId },
    );

    expect(result.action).toBe('generate');
    const [request] = await ctx.db
      .select({ titleSeed: generationRequests.titleSeed })
      .from(generationRequests)
      .where(eq(generationRequests.activitySessionId, sessionId));
    // First request of the session → request index 0; materialization then titles
    // the call's two sibling tracks with ordinals 0 and 1.
    expect(request!.titleSeed).toBe(0);
  });

  it('PLAYBACK GATE — an active-but-idle session below the watermark spends nothing', async () => {
    const ownerUserId = await createUser(ctx.db);
    // Started well outside the liveness window, no playback report, no resume:
    // an active session someone left behind after its first batch.
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' },
      startedAt: new Date(NOW.getTime() - 10 * 60_000),
    });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    await createProviderJob(ctx.db, { generationRequestId: requestId, normalizedStatus: 'ready' });
    const { provider, calls } = countingMusicProvider(async () => okTask('mock-gate-1'));

    const result = await runEnsureSessionBuffer(
      {
        db: ctx.db,
        music: provider,
        now: NOW,
        limits: ampleLimits(),
        stallThresholdMs: NEVER_STALE,
      },
      { sessionId },
    );

    // Below the watermark (0 ready) but nobody is listening → no paid call.
    expect(result.action).toBe('noop');
    expect(result.generationStatus).toBe('ok');
    expect(calls()).toBe(0);
  });

  it('FIRST FILL — a stalled cold start buys its first batch once the slot frees, with no listener', async () => {
    const oneSlot = limits({
      dailyGenerationTasks: 100,
      monthlyGenerationTasks: 1000,
      maxConcurrentJobs: 1,
    });
    const ownerUserId = await createUser(ctx.db);
    // The superseded Session's batch still holds the owner's only slot…
    const supersededId = await createSession(ctx.db, {
      ownerUserId,
      status: 'stopped',
      styleSnapshot: { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' },
    });
    const supersededRequestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: supersededId,
    });
    const supersededJobId = await createProviderJob(ctx.db, {
      generationRequestId: supersededRequestId,
      normalizedStatus: 'processing',
      updatedAt: NOW,
    });
    // …past the new Session's listener window: nothing played, nothing reported.
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: { stylePrompt: 'ambient piano', bpm: 70, key: 'C major' },
      startedAt: new Date(NOW.getTime() - 5 * 60_000),
    });
    const { provider, calls } = countingMusicProvider(async () => okTask('first-fill-1'));
    const tick = (now: Date) =>
      runEnsureSessionBuffer(
        { db: ctx.db, music: provider, now, limits: oneSlot, stallThresholdMs: NEVER_STALE },
        { sessionId },
      );

    expect((await tick(NOW)).action).toBe('wait');
    expect(calls()).toBe(0);

    await ctx.db
      .update(providerJobs)
      .set({ normalizedStatus: 'ready' })
      .where(eq(providerJobs.id, supersededJobId));
    const filled = await tick(NOW);
    expect(filled.action).toBe('generate');
    expect(filled.submittedTaskId).toBe('first-fill-1');

    // Bounded to the first batch: once it is bought, the top-up waits for a listener.
    await ctx.db
      .update(providerJobs)
      .set({ normalizedStatus: 'ready' })
      .where(eq(providerJobs.id, filled.submittedProviderJobId!));
    expect((await tick(new Date(NOW.getTime() + 60_000))).action).toBe('noop');
    expect(calls()).toBe(1);
  });

  it('PLAYBACK GATE — a recent playback report re-opens generation', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' },
      startedAt: new Date(NOW.getTime() - 10 * 60_000),
      // The player reported playback moments ago (position pings arrive ~5s
      // apart while audio plays) → the listener is live, top-ups may spend.
      lastPlaybackReportAt: new Date(NOW.getTime() - 30_000),
    });
    const { provider, calls } = countingMusicProvider(async () => okTask('mock-gate-2'));

    const result = await runEnsureSessionBuffer(
      {
        db: ctx.db,
        music: provider,
        now: NOW,
        limits: ampleLimits(),
        stallThresholdMs: NEVER_STALE,
      },
      { sessionId },
    );

    expect(result.action).toBe('generate');
    expect(calls()).toBe(1);
  });

  it('LOOP HOLD — a 10-minute held loop below the watermark submits ZERO new provider jobs, then a lapsed lease resumes prefill', async () => {
    const ownerUserId = await createUser(ctx.db);
    const start = NOW;
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' },
      startedAt: new Date(start.getTime() - 60 * 60_000),
    });
    const { provider, calls } = countingMusicProvider(async (_input, n) => okTask(`loop-${n}`));
    const clientId = 'loop-tab-1';

    // Toggle-on: the acknowledged acquire (the UI reflects this response).
    const acquired = await applyLoopLease(ctx.db, {
      ownerUserId,
      sessionId,
      clientId,
      epoch: start.getTime(),
      action: 'acquire',
      now: start,
    });
    expect(acquired.ok && acquired.applied && acquired.state.held).toBe(true);

    // The REAL sweep, tick by tick over the held 10 minutes: the player keeps
    // pinging position reports (listener stays live — the lease, not liveness,
    // must stop the spend) and renews the lease on its report cadence, with
    // margin below the 60 s TTL (here every 30 s; live clients renew ~5 s).
    for (let halfMinute = 0; halfMinute <= 20; halfMinute += 1) {
      const now = new Date(start.getTime() + halfMinute * 30_000);
      if (halfMinute > 0) {
        const renewed = await applyLoopLease(ctx.db, {
          ownerUserId,
          sessionId,
          clientId,
          epoch: now.getTime(),
          action: 'renew',
          now,
        });
        expect(renewed.ok && renewed.applied).toBe(true);
      }
      if (halfMinute % 2 !== 0) continue; // the sweep ticks every 60 s
      await ctx.db
        .update(activitySessions)
        .set({ lastPlaybackReportAt: now })
        .where(eq(activitySessions.id, sessionId));
      const result = await runEnsureSessionBuffer(
        { db: ctx.db, music: provider, now, limits: ampleLimits(), stallThresholdMs: NEVER_STALE },
        { sessionId },
      );
      // Prefill stopped within ONE sweep tick of the acknowledged hold
      // (minute 0 is the first tick after the acquire) and stays stopped.
      expect(result.action).toBe('noop');
      expect(result.generationStatus).toBe('ok');
    }
    // The provider-job table shows ZERO new jobs for the whole held window.
    expect(await sessionJobs(sessionId)).toHaveLength(0);
    expect(calls()).toBe(0);

    // The lease lapses (lock-screen throttling / network loss: no renewal past
    // the TTL) → the very next sweep resumes normal prefill.
    const afterLapse = new Date(start.getTime() + 12 * 60_000);
    await ctx.db
      .update(activitySessions)
      .set({ lastPlaybackReportAt: afterLapse })
      .where(eq(activitySessions.id, sessionId));
    const resumed = await runEnsureSessionBuffer(
      {
        db: ctx.db,
        music: provider,
        now: afterLapse,
        limits: ampleLimits(),
        stallThresholdMs: NEVER_STALE,
      },
      { sessionId },
    );
    expect(resumed.action).toBe('generate');
    expect(calls()).toBe(1);
    expect(await sessionJobs(sessionId)).toHaveLength(1);
  });

  it('LOOP HOLD — a released lease resumes prefill on the next tick (toggle-off)', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' },
      startedAt: NOW,
      lastPlaybackReportAt: NOW,
    });
    const { provider, calls } = countingMusicProvider(async () => okTask('loop-release-1'));
    const deps = {
      db: ctx.db,
      music: provider,
      now: NOW,
      limits: ampleLimits(),
      stallThresholdMs: NEVER_STALE,
    };
    await applyLoopLease(ctx.db, {
      ownerUserId,
      sessionId,
      clientId: 'loop-tab-1',
      epoch: NOW.getTime(),
      action: 'acquire',
      now: NOW,
    });
    expect((await runEnsureSessionBuffer(deps, { sessionId })).action).toBe('noop');
    expect(calls()).toBe(0);

    await applyLoopLease(ctx.db, {
      ownerUserId,
      sessionId,
      clientId: 'loop-tab-1',
      epoch: NOW.getTime() + 1,
      action: 'release',
      now: NOW,
    });
    expect((await runEnsureSessionBuffer(deps, { sessionId })).action).toBe('generate');
    expect(calls()).toBe(1);
  });

  it('does not schedule a poll when an uncertain submit parks the job (no task id)', async () => {
    const { sessionId } = await freshGeneratingSession();
    const { provider } = countingMusicProvider(async () => {
      throw new Error('network blip mid-submit');
    });
    const enqueuePoll = vi.fn(async () => {});
    await expect(
      runEnsureSessionBuffer(
        {
          db: ctx.db,
          music: provider,
          now: NOW,
          limits: ampleLimits(),
          stallThresholdMs: NEVER_STALE,
          enqueuePoll,
        },
        { sessionId },
      ),
    ).rejects.toThrow('network blip');
    expect(enqueuePoll).not.toHaveBeenCalled();
  });

  describe('usage_events spend ledger', () => {
    async function ownerUsageEvents(ownerUserId: string) {
      return ctx.db
        .select({
          providerType: usageEvents.providerType,
          providerKey: usageEvents.providerKey,
          operation: usageEvents.operation,
          units: usageEvents.units,
          metadata: usageEvents.metadata,
        })
        .from(usageEvents)
        .where(eq(usageEvents.userId, ownerUserId));
    }

    it('appends one generate event per successful paid submit', async () => {
      const { ownerUserId, sessionId } = await freshGeneratingSession();
      const { provider } = countingMusicProvider(async () => okTask('mock-ledger-1'));

      const result = await runEnsureSessionBuffer(
        { db: ctx.db, music: provider, now: NOW, limits: ampleLimits() },
        { sessionId },
      );
      expect(result.action).toBe('generate');

      const events = await ownerUsageEvents(ownerUserId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        providerType: 'music',
        providerKey: 'mock',
        operation: 'generate',
        // Internal task units: one provider call, not per track.
        units: 1,
      });
      expect(events[0]!.metadata).toMatchObject({
        outcome: 'submitted',
        providerJobId: result.submittedProviderJobId,
        providerTaskId: 'mock-ledger-1',
      });
    });

    it('records an uncertain submit too (it may have charged) — and a retry adds no second row', async () => {
      const { ownerUserId, sessionId } = await freshGeneratingSession();
      const { provider, calls } = countingMusicProvider(async () => {
        throw new Error('network blip mid-submit');
      });
      const deps = { db: ctx.db, music: provider, now: NOW, limits: ampleLimits() };

      await expect(runEnsureSessionBuffer(deps, { sessionId })).rejects.toThrow('network blip');

      const events = await ownerUsageEvents(ownerUserId);
      expect(events).toHaveLength(1);
      expect(events[0]!.metadata).toMatchObject({ outcome: 'submit_unknown' });

      // The Graphile retry sees the parked in-flight job → no new call, no new row.
      await runEnsureSessionBuffer(deps, { sessionId });
      expect(calls()).toBe(1);
      expect(await ownerUsageEvents(ownerUserId)).toHaveLength(1);
    });
  });

  it('two overlapping sweeps for one session submit only the needed new provider job', async () => {
    const { sessionId } = await freshGeneratingSession();
    const { provider, calls } = countingMusicProvider(async (_input, n) =>
      okTask(`mock-sweep-${n}`),
    );
    const deps = {
      db: ctx.db,
      music: provider,
      now: NOW,
      limits: ampleLimits(),
      stallThresholdMs: NEVER_STALE,
    };

    // Sweep A submits one job; the in-flight provider work then covers the buffer.
    const a = await runEnsureSessionBuffer(deps, { sessionId });
    expect(a.action).toBe('generate');
    expect(a.submittedTaskId).toBe('mock-sweep-1');

    // Sweep B (overlapping, same session) sees the in-flight job and does not re-submit.
    const b = await runEnsureSessionBuffer(deps, { sessionId });
    expect(b.action).toBe('noop');

    expect(calls()).toBe(1);
    const jobs = await sessionJobs(sessionId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.providerTaskId).toBe('mock-sweep-1');
  });

  // --- Pipeline dead-ends: every block must eventually clear ----------------------

  const SNAPSHOT = { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' };
  /** The style identity the controller stores/compares for SNAPSHOT — the
   *  session-frozen style, NOT a per-track compile (those fold in a variation). */
  const COMPILED_STYLE = buildSessionStyle(sessionStyleSnapshotSchema.parse(SNAPSHOT));

  /** A session whose LATEST provider job is staged in the given condition. */
  async function sessionWithLatestJob(job: {
    normalizedStatus: string;
    submitState?: 'submitting' | 'submitted' | 'submit_unknown' | 'submit_rejected';
    providerTaskId?: string | null;
    updatedAt?: Date;
    requestStylePrompt?: string | null;
  }): Promise<{ ownerUserId: string; sessionId: string }> {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId, styleSnapshot: SNAPSHOT });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      stylePrompt: job.requestStylePrompt ?? null,
    });
    await createProviderJob(ctx.db, {
      generationRequestId: requestId,
      submitState: job.submitState ?? 'submitted',
      normalizedStatus: job.normalizedStatus,
      createdAt: NOW,
      ...(job.providerTaskId !== undefined ? { providerTaskId: job.providerTaskId } : {}),
      ...(job.updatedAt ? { updatedAt: job.updatedAt } : {}),
    });
    return { ownerUserId, sessionId };
  }

  async function statusMessage(sessionId: string): Promise<string | null> {
    const [row] = await ctx.db
      .select({ statusMessageSafe: activitySessions.statusMessageSafe })
      .from(activitySessions)
      .where(eq(activitySessions.id, sessionId));
    return row!.statusMessageSafe;
  }

  const HOUR_BEFORE = new Date(NOW.getTime() - 60 * 60_000);

  it('never auto-resubmits a policy-blocked prompt, and tells the user to change the vibe', async () => {
    // The blocked job carries the SAME compiled style the session would submit again.
    const { sessionId } = await sessionWithLatestJob({
      normalizedStatus: 'blocked_by_policy',
      requestStylePrompt: COMPILED_STYLE,
      updatedAt: HOUR_BEFORE, // no clock ever lifts a policy block
    });
    const { provider, calls } = countingMusicProvider(async () => {
      throw new Error('a policy-blocked prompt must not be resubmitted');
    });

    const result = await runEnsureSessionBuffer(
      { db: ctx.db, music: provider, now: NOW, limits: ampleLimits() },
      { sessionId },
    );

    expect(result.action).toBe('noop');
    expect(result.generationStatus).toBe('provider_error');
    expect(calls()).toBe(0);
    expect(await statusMessage(sessionId)).toContain('Change Vibe');
  });

  it('a Change Vibe (different compiled style) lifts the policy block and generation resumes', async () => {
    // The blocked job's style differs from what the CURRENT snapshot compiles to —
    // the user already edited the vibe, so the block no longer applies.
    const { sessionId } = await sessionWithLatestJob({
      normalizedStatus: 'blocked_by_policy',
      requestStylePrompt: 'the old, provider-blocked style',
    });
    const { provider, calls } = countingMusicProvider(async () => okTask('mock-after-vibe'));

    const result = await runEnsureSessionBuffer(
      { db: ctx.db, music: provider, now: NOW, limits: ampleLimits() },
      { sessionId },
    );

    expect(result.action).toBe('generate');
    expect(result.submittedTaskId).toBe('mock-after-vibe');
    expect(calls()).toBe(1);
  });

  it('terminal provider blocks decay after their cooldown and generation auto-resumes', async () => {
    // One credits-blocked and one failed job, both older than their cooldown: neither
    // may block the session forever (e.g. credits were topped up long ago).
    for (const normalizedStatus of ['blocked_by_provider_credits', 'failed_final'] as const) {
      const { sessionId } = await sessionWithLatestJob({
        normalizedStatus,
        updatedAt: HOUR_BEFORE,
      });
      const { provider } = countingMusicProvider(async (_input, n) =>
        okTask(`mock-decay-${normalizedStatus}-${n}`),
      );

      const result = await runEnsureSessionBuffer(
        { db: ctx.db, music: provider, now: NOW, limits: ampleLimits() },
        { sessionId },
      );

      expect(result.action).toBe('generate');
      expect(result.generationStatus).toBe('ok');
    }
  });

  it('a fresh reroll after rejected siblings never resubmits the first request (monotonic index)', async () => {
    // One COMPLETED prior generation whose tracks were all disliked away: the
    // session's ready count is back to 0, but the compile index must not be —
    // otherwise the fresh reroll re-derives track 0's hidden seed and submits a
    // byte-identical request (the failure the sibling fallback can't cover).
    const { sessionId } = await sessionWithLatestJob({
      normalizedStatus: 'ready',
      updatedAt: HOUR_BEFORE,
    });
    const parsed = sessionStyleSnapshotSchema.parse(SNAPSHOT);
    let submitted: MusicGenerationInput | undefined;
    const { provider, calls } = countingMusicProvider(async (input) => {
      submitted = input;
      return okTask('mock-fresh-reroll');
    });

    const result = await runEnsureSessionBuffer(
      { db: ctx.db, music: provider, now: NOW, limits: ampleLimits() },
      { sessionId },
    );

    expect(result.action).toBe('generate');
    expect(calls()).toBe(1);
    // Compiled at index 1 (one prior request exists) — never index 0 again.
    expect(submitted).toEqual(compileMusicGenerationInput(parsed, 1));
    expect(submitted!.seed).not.toBe(buildTrackPrompt(parsed, 0).seed);
    expect(submitted!.style).not.toBe(compileMusicGenerationInput(parsed, 0).style);
  });

  /** A session whose latest job is a definitive refusal, long past every cooldown. */
  const refusedLongAgo = {
    normalizedStatus: 'submit_rejected',
    submitState: 'submit_rejected',
    providerTaskId: null,
    requestStylePrompt: COMPILED_STYLE,
    updatedAt: HOUR_BEFORE,
  } as const;

  it('a definitive refusal never resubmits on a clock, however long it sits', async () => {
    // A refusal is unbilled, so the cost limits that bound every other retry
    // never engage: with a decaying block this session would issue a fresh
    // refused request every cooldown for as long as anyone is listening.
    const { sessionId } = await sessionWithLatestJob(refusedLongAgo);
    const { provider, calls } = countingMusicProvider(async () => {
      throw new Error('a refused request must not be resubmitted');
    });
    const deps = { db: ctx.db, music: provider, now: NOW, limits: ampleLimits() };

    expect((await runEnsureSessionBuffer(deps, { sessionId })).action).toBe('noop');
    expect((await runEnsureSessionBuffer(deps, { sessionId })).generationStatus).toBe(
      'provider_error',
    );
    expect(calls()).toBe(0);
    expect(await statusMessage(sessionId)).toContain('refused');
  });

  /** Store the instance music credential, dated — the provider-config revision. */
  async function storeMusicCredential(updatedAt: Date): Promise<void> {
    await ctx.db.insert(providerCredentials).values({
      providerType: 'music',
      providerKey: music.providerKey,
      displayName: 'Mock music',
      source: 'database',
      updatedAt,
    });
  }

  it('a worker restart alone re-opens nothing once a credential is stored', async () => {
    // The process boundary stands in for an ENV-sourced credential's revision.
    // Reading it unconditionally would make every deploy re-open every refused
    // Session for one more refused submit on a database-credential instance.
    const { sessionId } = await sessionWithLatestJob(refusedLongAgo);
    await storeMusicCredential(new Date(HOUR_BEFORE.getTime() - 60_000));
    const { provider, calls } = countingMusicProvider(async () => {
      throw new Error('a deploy must not resubmit a refused request');
    });
    vi.stubEnv('SUNO_API_KEY', '');
    vi.stubEnv('SUNO_BASE_URL', '');

    try {
      const result = await runEnsureSessionBuffer(
        {
          db: ctx.db,
          music: provider,
          now: NOW,
          limits: ampleLimits(),
          // Restarted after the refusal, but the stored credential is older.
          workerStartedAt: NOW,
        },
        { sessionId },
      );

      expect(result.action).toBe('noop');
      expect(calls()).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // A saved row is only the fallback beside an env key, and an env change takes
  // a restart: the restart is that key's revision, whatever the row's own date.
  it('a restart re-opens a refused session whose key comes from the env, even beside a stored row', async () => {
    const { sessionId } = await sessionWithLatestJob(refusedLongAgo);
    await storeMusicCredential(new Date(HOUR_BEFORE.getTime() - 60_000));
    const { provider, calls } = countingMusicProvider(async () => okTask('after-env-key'));
    vi.stubEnv('SUNO_API_KEY', 'env-key');

    try {
      const result = await runEnsureSessionBuffer(
        {
          db: ctx.db,
          music: provider,
          now: NOW,
          limits: ampleLimits(),
          workerStartedAt: NOW,
        },
        { sessionId },
      );

      expect(result.action).toBe('generate');
      expect(calls()).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('Resume re-opens a refused session', async () => {
    // The refusal is terminal, not permanent: with no way back the listener
    // could only abandon the Session.
    const { sessionId } = await sessionWithLatestJob(refusedLongAgo);
    await ctx.db
      .update(activitySessions)
      .set({ lastResumedAt: NOW })
      .where(eq(activitySessions.id, sessionId));
    const { provider, calls } = countingMusicProvider(async () => okTask('after-resume'));

    const result = await runEnsureSessionBuffer(
      { db: ctx.db, music: provider, now: NOW, limits: ampleLimits() },
      { sessionId },
    );

    expect(result.action).toBe('generate');
    expect(calls()).toBe(1);
  });

  it('a provider-credential update re-opens a refused session', async () => {
    const { sessionId } = await sessionWithLatestJob(refusedLongAgo);
    await storeMusicCredential(NOW);
    const { provider, calls } = countingMusicProvider(async () => okTask('after-credential'));

    const result = await runEnsureSessionBuffer(
      { db: ctx.db, music: provider, now: NOW, limits: ampleLimits() },
      { sessionId },
    );

    expect(result.action).toBe('generate');
    expect(calls()).toBe(1);
  });

  // A refusal bought nothing and has no task to wait on, so it holds no Buffer
  // or concurrency slot: a fix made minutes after it takes effect at once.
  it.each(['resume', 'credential'] as const)(
    'a recent refusal re-opens at once on a %s',
    async (trigger) => {
      const refusedAt = new Date(NOW.getTime() - 5 * 60_000);
      const { sessionId } = await sessionWithLatestJob({ ...refusedLongAgo, updatedAt: refusedAt });
      if (trigger === 'resume') {
        await ctx.db
          .update(activitySessions)
          .set({ lastResumedAt: NOW })
          .where(eq(activitySessions.id, sessionId));
      } else {
        await storeMusicCredential(new Date(NOW.getTime() - 60_000));
      }
      const { provider, calls } = countingMusicProvider(async () => okTask(`after-${trigger}`));

      const result = await runEnsureSessionBuffer(
        { db: ctx.db, music: provider, now: NOW, limits: ampleLimits() },
        { sessionId },
      );

      expect(result.action).toBe('generate');
      expect(calls()).toBe(1);
    },
  );

  it("a recent refusal in a stopped Session leaves the owner's one concurrency slot free", async () => {
    const refusedAt = new Date(NOW.getTime() - 5 * 60_000);
    const { ownerUserId, sessionId: refused } = await sessionWithLatestJob({
      ...refusedLongAgo,
      updatedAt: refusedAt,
    });
    await ctx.db
      .update(activitySessions)
      .set({ status: 'stopped' })
      .where(eq(activitySessions.id, refused));
    const sessionId = await createSession(ctx.db, { ownerUserId, styleSnapshot: SNAPSHOT });
    const { provider, calls } = countingMusicProvider(async () => okTask('next-session'));

    const result = await runEnsureSessionBuffer(
      { db: ctx.db, music: provider, now: NOW, limits: { ...ampleLimits(), maxConcurrentJobs: 1 } },
      { sessionId },
    );

    expect(result.action).toBe('generate');
    expect(calls()).toBe(1);
  });

  it('a fresh terminal failure still blocks (cooldown not yet elapsed)', async () => {
    const { sessionId } = await sessionWithLatestJob({
      normalizedStatus: 'failed_final',
      updatedAt: NOW,
    });
    const { provider, calls } = countingMusicProvider(async () => {
      throw new Error('must not retry within the cooldown');
    });

    const result = await runEnsureSessionBuffer(
      { db: ctx.db, music: provider, now: NOW, limits: ampleLimits() },
      { sessionId },
    );

    expect(result.action).toBe('noop');
    expect(result.generationStatus).toBe('provider_error');
    expect(calls()).toBe(0);
  });

  it('a parked submit_unknown surfaces worker_stalled while it holds its slot…', async () => {
    const { sessionId } = await sessionWithLatestJob({
      normalizedStatus: 'submit_unknown',
      submitState: 'submit_unknown',
      providerTaskId: null,
      updatedAt: new Date(NOW.getTime() - 6 * 60_000), // past stall, within the phantom bound
    });
    const { provider, calls } = countingMusicProvider(async () => {
      throw new Error('the parked submit still holds the buffer slot');
    });

    const result = await runEnsureSessionBuffer(
      { db: ctx.db, music: provider, now: NOW, limits: ampleLimits() },
      { sessionId },
    );

    expect(result.action).toBe('noop');
    expect(result.generationStatus).toBe('worker_stalled'); // no longer silently `ok`
    expect(calls()).toBe(0);
  });

  it('…and releases the slot past the phantom age bound so the session recovers', async () => {
    const { sessionId } = await sessionWithLatestJob({
      normalizedStatus: 'submit_unknown',
      submitState: 'submit_unknown',
      providerTaskId: null,
      updatedAt: HOUR_BEFORE,
    });
    const { provider, calls } = countingMusicProvider(async () => okTask('mock-recovered'));

    const result = await runEnsureSessionBuffer(
      { db: ctx.db, music: provider, now: NOW, limits: ampleLimits() },
      { sessionId },
    );

    // A NEW job is submitted (the parked one is never itself resubmitted).
    expect(result.action).toBe('generate');
    expect(result.generationStatus).toBe('ok');
    expect(calls()).toBe(1);
    const jobs = await sessionJobs(sessionId);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.submitState).sort()).toEqual(['submit_unknown', 'submitted']);
  });

  // --- Cost-control races: caps are non-bypassable ACROSS sessions ----------------
  // Per-session job_key serialization does not cover two sessions of the same
  // owner (a stale tick can overlap the next session's tick when the user hops
  // sessions). The schema allows only one ACTIVE session per owner, so the
  // overlap is staged the way it happens live: the first session's tick is held
  // mid-paid-call — its `submitting` (queued) intent-to-spend row committed —
  // while the owner's NEXT session ticks.

  /** An owner mid-session-hop: tick A is gated inside the paid call, B is now active. */
  async function ownerMidPaidCall(deps: { limits: UsageLimits }): Promise<{
    ownerUserId: string;
    winner: Promise<EnsureResult>;
    loserSessionId: string;
    calls: () => number;
    releaseWinner: () => void;
  }> {
    const ownerUserId = await createUser(ctx.db);
    const styleSnapshot = { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' };
    const sessionA = await createSession(ctx.db, { ownerUserId, styleSnapshot });
    const sessionB = await createSession(ctx.db, { ownerUserId, styleSnapshot, status: 'stopped' });

    // Hold the paid call open: the job sits in the `submitting`/`queued` paid-call
    // window — exactly the state the pre-fix concurrency count ignored.
    let releaseWinner!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const { provider, calls } = countingMusicProvider(async (_input, n) => {
      await gate;
      return okTask(`mock-race-${n}`);
    });

    const winner = runEnsureSessionBuffer(
      { db: ctx.db, music: provider, now: NOW, limits: deps.limits, stallThresholdMs: NEVER_STALE },
      { sessionId: sessionA },
    );
    // The winner has committed its `submitting` row and entered the paid call.
    await vi.waitFor(() => expect(calls()).toBe(1));

    // The user hops sessions: A stops, B becomes the owner's active session.
    await ctx.db
      .update(activitySessions)
      .set({ status: 'stopped' })
      .where(eq(activitySessions.id, sessionA));
    await ctx.db
      .update(activitySessions)
      .set({ status: 'active' })
      .where(eq(activitySessions.id, sessionB));

    return { ownerUserId, winner, loserSessionId: sessionB, calls, releaseWinner };
  }
  type EnsureResult = Awaited<ReturnType<typeof runEnsureSessionBuffer>>;

  it('the next session cannot spend past the cap while a submit is mid-paid-call', async () => {
    const capOne = limits({
      dailyGenerationTasks: 1,
      monthlyGenerationTasks: 100,
      maxConcurrentJobs: 5,
    });
    const { ownerUserId, winner, loserSessionId, calls, releaseWinner } = await ownerMidPaidCall({
      limits: capOne,
    });

    // The mid-call `submitting` row already claimed the last budgeted task.
    const loser = await runEnsureSessionBuffer(
      { db: ctx.db, music, now: NOW, limits: capOne, stallThresholdMs: NEVER_STALE },
      { sessionId: loserSessionId },
    );
    expect(loser.action).toBe('session_repeat');
    expect(loser.generationStatus).toBe('repeat_cost_limit');
    expect(calls()).toBe(1);

    releaseWinner();
    expect((await winner).action).toBe('generate');
    expect(
      await countTasksInWindow(ctx.db, {
        scope: ownerScope(ownerUserId),
        since: new Date('2026-06-29T00:00:00Z'),
      }),
    ).toBe(1);
  });

  it('with maxConcurrentJobs = 1 the next session waits while a submit is mid-paid-call', async () => {
    const oneSlot = limits({
      dailyGenerationTasks: 100,
      monthlyGenerationTasks: 1000,
      maxConcurrentJobs: 1,
    });
    const { winner, loserSessionId, calls, releaseWinner } = await ownerMidPaidCall({
      limits: oneSlot,
    });

    // The mid-call job counts as in flight → no free concurrency slot → wait.
    const loser = await runEnsureSessionBuffer(
      { db: ctx.db, music, now: NOW, limits: oneSlot, stallThresholdMs: NEVER_STALE },
      { sessionId: loserSessionId },
    );
    expect(loser.action).toBe('wait');
    expect(calls()).toBe(1);

    releaseWinner();
    const won = await winner;
    expect(won.action).toBe('generate');
    expect(won.submittedTaskId).toBe('mock-race-1');
  });

  /**
   * Run a tick against a session mutated WHILE the tick waits at the owner lock:
   * the holder acquires the lock first, the tick completes its (soon stale)
   * pre-lock read and parks at the lock boundary, then `mutate` runs on the
   * holder's own transaction — committing exactly when the lock releases, so the
   * parked tick's in-lock re-read always sees the committed mutation.
   */
  async function tickAgainstLockedMutation(args: {
    ownerUserId: string;
    sessionId: string;
    provider: MusicProvider;
    limits?: UsageLimits;
    mutate: (tx: Transaction) => Promise<void>;
  }): Promise<EnsureResult> {
    let lockAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const lockHeld = withOwnerGenerationLock(ctx.db, args.ownerUserId, async (tx) => {
      lockAcquired();
      // Let the tick pass its pre-lock read and park at the lock. (If it ever
      // hasn't by now, the mutation simply commits before the tick's pre-lock
      // read — the assertions hold either way, just via the outer guard.)
      await new Promise((resolve) => setTimeout(resolve, 50));
      await args.mutate(tx);
    });
    await acquired;

    const result = await runEnsureSessionBuffer(
      {
        db: ctx.db,
        music: args.provider,
        now: NOW,
        limits: args.limits ?? ampleLimits(),
        stallThresholdMs: NEVER_STALE,
      },
      { sessionId: args.sessionId },
    );
    await lockHeld;
    return result;
  }

  it('a tick whose session was stopped while it waited at the owner lock spends nothing', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' },
      // Non-default status fields so a scribble would be visible.
      generationStatus: 'worker_stalled',
    });
    await ctx.db
      .update(activitySessions)
      .set({ statusMessageSafe: 'pre-existing message' })
      .where(eq(activitySessions.id, sessionId));
    const { provider, calls } = countingMusicProvider(async () => {
      throw new Error('a stopped session must never spend');
    });

    const result = await tickAgainstLockedMutation({
      ownerUserId,
      sessionId,
      provider,
      mutate: (tx) =>
        tx
          .update(activitySessions)
          .set({ status: 'stopped' })
          .where(eq(activitySessions.id, sessionId))
          .then(() => undefined),
    });

    // The in-lock re-read sees `stopped`: no spend row, no paid call, and no
    // status scribble on the stopped session.
    expect(result.action).toBe('noop');
    expect(calls()).toBe(0);
    expect(await sessionJobs(sessionId)).toHaveLength(0);
    expect((await sessionStatus(sessionId)).generationStatus).toBe('worker_stalled');
    expect(await statusMessage(sessionId)).toBe('pre-existing message');
  });

  it('a Change Vibe committed while the tick waited at the lock is what gets submitted', async () => {
    const { ownerUserId, sessionId } = await freshGeneratingSession();
    const newSnapshot = { stylePrompt: 'ambient piano', bpm: 70, key: 'C major' };
    // What the controller stores for the NEW snapshot: its session-frozen style.
    const newStyle = buildSessionStyle(sessionStyleSnapshotSchema.parse(newSnapshot));
    const { provider, calls } = countingMusicProvider(async () => okTask('mock-after-restyle'));

    const result = await tickAgainstLockedMutation({
      ownerUserId,
      sessionId,
      provider,
      mutate: (tx) =>
        tx
          .update(activitySessions)
          .set({ sessionStyleSnapshot: newSnapshot })
          .where(eq(activitySessions.id, sessionId))
          .then(() => undefined),
    });

    // The submit compiled from the in-lock re-read, not the stale pre-lock snapshot.
    expect(result.action).toBe('generate');
    expect(calls()).toBe(1);
    const [request] = await ctx.db
      .select({ stylePrompt: generationRequests.stylePrompt })
      .from(generationRequests)
      .where(eq(generationRequests.activitySessionId, sessionId));
    expect(request!.stylePrompt).toBe(newStyle);
  });

  it('a Repeat switch committed while the tick waited at the lock stops the paid submit', async () => {
    // A complete set (ownReady = bufferAheadTracks) whose keep_going tick would
    // still generate (ready-ahead is 0); switched to Repeat while parked.
    const { ownerUserId, sessionId } = await seedSessionWithOwnTracks(3);
    const { provider, calls } = countingMusicProvider(async () => {
      throw new Error('a Repeat session with a complete set must not generate');
    });

    const result = await tickAgainstLockedMutation({
      ownerUserId,
      sessionId,
      provider,
      mutate: (tx) =>
        tx
          .update(activitySessions)
          .set({ sessionMode: 'repeat' })
          .where(eq(activitySessions.id, sessionId))
          .then(() => undefined),
    });

    expect(result.action).toBe('voluntary_repeat');
    expect(result.generationStatus).toBe('ok');
    expect(calls()).toBe(0);
    expect(result.loopTrackIds).toHaveLength(3);
  });

  // --- Generation-time blend identity + fresh-call reroll -------------------

  async function sessionRequests(sessionId: string) {
    return ctx.db
      .select({
        id: generationRequests.id,
        stylePrompt: generationRequests.stylePrompt,
        styleSnapshot: generationRequests.styleSnapshot,
        styleRevision: generationRequests.styleRevision,
        targetBpm: generationRequests.targetBpm,
        targetKey: generationRequests.targetKey,
        userPrompt: generationRequests.userPrompt,
        createdAt: generationRequests.createdAt,
      })
      .from(generationRequests)
      .where(eq(generationRequests.activitySessionId, sessionId))
      .orderBy(generationRequests.createdAt);
  }

  it('stamps every submit with the snapshot blend identity (revision + frozen BPM/key)', async () => {
    const { sessionId } = await freshGeneratingSession(); // snapshot bpm 96, key 'A minor'
    const { provider } = countingMusicProvider(async () => okTask('mock-identity-1'));

    const result = await runEnsureSessionBuffer(
      {
        db: ctx.db,
        music: provider,
        now: NOW,
        limits: ampleLimits(),
        stallThresholdMs: NEVER_STALE,
      },
      { sessionId },
    );

    expect(result.action).toBe('generate');
    const [request] = await sessionRequests(sessionId);
    expect(request).toMatchObject({ styleRevision: 1, targetBpm: 96, targetKey: 'A minor' });
    // The compilation context is persisted too — what a future reroll re-compiles.
    expect(request!.styleSnapshot).toMatchObject({ bpm: 96, key: 'A minor' });
  });

  it('a fresh reroll carries the disliked request identity with a rotated hidden seed', async () => {
    // 1. First submit (revision 1, 96 bpm, A minor). Keep Going throughout: the
    // fresh-call reroll is a `keep_going` demand, and the planner is
    // reroll-first, so each tick below submits exactly one job.
    const { ownerUserId, sessionId } = await freshGeneratingSession();
    let firstInput: MusicGenerationInput | undefined;
    const { provider } = countingMusicProvider(async (input, n) => {
      firstInput = input;
      return okTask(`mock-reroll-${n}`);
    });
    const deps = {
      db: ctx.db,
      music: provider,
      now: NOW,
      limits: ampleLimits(),
      stallThresholdMs: NEVER_STALE,
    };
    await runEnsureSessionBuffer(deps, { sessionId });
    const [original] = await sessionRequests(sessionId);

    // 2. Its track lands (the job completes — no longer in-flight), is DISLIKED,
    //    and the dislike marks the fresh-call reroll intent (what the dislike
    //    route does when no sibling remains).
    const [job] = await ctx.db
      .select({ id: providerJobs.id })
      .from(providerJobs)
      .where(eq(providerJobs.generationRequestId, original!.id));
    await ctx.db
      .update(providerJobs)
      .set({ normalizedStatus: 'ready' })
      .where(eq(providerJobs.id, job!.id));
    const dislikedTrackId = await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: original!.id,
      providerJobId: job!.id,
      status: 'rejected',
      dislikedAt: NOW,
      rerollPendingAt: NOW,
    });

    // 3. The next generate is the reroll: it copies the ORIGINAL request's
    //    identity + style prompt.
    let submittedInput: MusicGenerationInput | undefined;
    const { provider: rerollProvider } = countingMusicProvider(async (input, n) => {
      submittedInput = input;
      return okTask(`mock-reroll-fresh-${n}`);
    });
    const result = await runEnsureSessionBuffer({ ...deps, music: rerollProvider }, { sessionId });
    expect(result.action).toBe('generate');

    const requests = await sessionRequests(sessionId);
    expect(requests).toHaveLength(2);
    const reroll = requests[1]!;
    expect(reroll.stylePrompt).toBe(original!.stylePrompt);
    expect(reroll.styleRevision).toBe(1);
    expect(reroll.targetBpm).toBe(96);
    expect(reroll.targetKey).toBe('A minor');
    // The provider call re-ran the SAME compiler over the ORIGINAL request's
    // persisted snapshot with a fresh index: same vibe + frozen tail, a rotated
    // hidden-seed variation.
    expect(submittedInput?.style).toContain('instrumental lofi');
    expect(submittedInput?.style).toContain('96 bpm');
    expect(submittedInput?.style).toContain('A minor');
    // The hidden seed ROTATED relative to the disliked request's own submit
    // (a hidden seed changes on a Dislike reroll) — the
    // reroll is never provider-identical to the original.
    expect(submittedInput?.seed).toBeTypeOf('number');
    expect(submittedInput?.seed).not.toBe(firstInput?.seed);
    expect(submittedInput?.style).not.toBe(firstInput?.style);

    // The intent was consumed — the disliked track no longer reads as pending.
    const dislikedRow = await rawTrackRow(ctx.db, dislikedTrackId);
    expect(dislikedRow?.reroll_pending_at).toBeNull();
  });

  // --- Frozen per-request prompt provenance -----------------------------------

  /** Free a session's only in-flight job so the next tick may submit again. */
  async function completeSessionJobs(sessionId: string): Promise<void> {
    const requests = await sessionRequests(sessionId);
    for (const request of requests) {
      await ctx.db
        .update(providerJobs)
        .set({ normalizedStatus: 'ready' })
        .where(eq(providerJobs.generationRequestId, request.id));
    }
  }

  it('stamps a submit with the session prompt history as it stands, and again after a change', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' },
      userPrompt: 'calm music for late-night coding',
    });
    const deps = {
      db: ctx.db,
      music: countingMusicProvider(async (_i, n) => okTask(`mock-stamp-${n}`)).provider,
      now: NOW,
      limits: ampleLimits(),
      stallThresholdMs: NEVER_STALE,
    };

    await runEnsureSessionBuffer(deps, { sessionId });
    expect((await sessionRequests(sessionId))[0]?.userPrompt).toBe(
      'calm music for late-night coding',
    );

    // A Change Vibe with text extends the session's history; the NEXT submit
    // freezes the extended story, while the first request keeps its own.
    await completeSessionJobs(sessionId);
    await ctx.db
      .update(activitySessions)
      .set({ userPrompt: 'calm music for late-night coding\n\nmehr rockiger', styleRevision: 2 })
      .where(eq(activitySessions.id, sessionId));

    await runEnsureSessionBuffer(deps, { sessionId });
    const requests = await sessionRequests(sessionId);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.userPrompt).toBe('calm music for late-night coding');
    expect(requests[1]?.userPrompt).toBe('calm music for late-night coding\n\nmehr rockiger');
  });

  it('caps a stamped prompt at the track-data bound', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' },
      userPrompt: 'x'.repeat(MAX_TRACK_DATA_PROMPT_LENGTH + 400),
    });

    await runEnsureSessionBuffer(
      {
        db: ctx.db,
        music: countingMusicProvider(async (_i, n) => okTask(`mock-cap-${n}`)).provider,
        now: NOW,
        limits: ampleLimits(),
        stallThresholdMs: NEVER_STALE,
      },
      { sessionId },
    );

    const stamped = (await sessionRequests(sessionId))[0]?.userPrompt;
    expect(stamped).toHaveLength(MAX_TRACK_DATA_PROMPT_LENGTH);
    expect(stamped?.endsWith('…')).toBe(true);
  });

  /**
   * A session whose only request is already disliked with a fresh-call reroll
   * pending, and whose stored prompt history has moved past what that request
   * froze.
   */
  async function seedRerollWithFrozenPrompt(
    original: { userPrompt?: string | null; styleSnapshot?: StyleSnapshot | null } = {},
  ): Promise<string> {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: { stylePrompt: 'ambient piano', bpm: 70, key: 'C major' },
      userPrompt: 'origin prompt\n\nmehr rockiger',
    });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      stylePrompt: 'instrumental lofi, 96 bpm, A minor',
      styleRevision: 1,
      ...original,
    });
    const jobId = await createProviderJob(ctx.db, {
      generationRequestId: requestId,
      submitState: 'submitted',
      normalizedStatus: 'ready',
      createdAt: NOW,
    });
    await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      status: 'rejected',
      dislikedAt: NOW,
      rerollPendingAt: NOW,
    });
    return sessionId;
  }

  async function runRerollTick(sessionId: string): Promise<void> {
    const result = await runEnsureSessionBuffer(
      {
        db: ctx.db,
        music: countingMusicProvider(async (_i, n) => okTask(`mock-reroll-prompt-${n}`)).provider,
        now: NOW,
        limits: ampleLimits(),
        stallThresholdMs: NEVER_STALE,
      },
      { sessionId },
    );
    expect(result.action).toBe('generate');
  }

  it('a reroll copies the disliked request’s frozen prompt, not the extended history', async () => {
    const sessionId = await seedRerollWithFrozenPrompt({
      userPrompt: 'origin prompt',
      styleSnapshot: { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' },
    });

    await runRerollTick(sessionId);

    const requests = await sessionRequests(sessionId);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.userPrompt).toBe('origin prompt');
  });

  it('a reroll of a legacy request stamps nothing (there is no frozen prompt to copy)', async () => {
    const sessionId = await seedRerollWithFrozenPrompt();

    await runRerollTick(sessionId);

    const requests = await sessionRequests(sessionId);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.userPrompt).toBeNull();
  });

  it('a play-out vibe switch submits the new revision while old-vibe Tracks remain queued', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      sessionMode: 'repeat',
      styleSnapshot: { stylePrompt: 'ambient piano', bpm: 70, key: 'C major' },
    });
    await ctx.db
      .update(activitySessions)
      .set({ styleRevision: 2, vibeSwitchRevision: null })
      .where(eq(activitySessions.id, sessionId));
    const oldRequestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      styleRevision: 1,
    });
    const oldJobId = await createProviderJob(ctx.db, {
      generationRequestId: oldRequestId,
      submitState: 'submitted',
      normalizedStatus: 'ready',
      createdAt: NOW,
    });
    const oldTrackId = await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: oldRequestId,
      providerJobId: oldJobId,
      providerTrackId: 'play-out-old-vibe',
      status: 'ready',
    });
    await createQueueItem(ctx.db, {
      activitySessionId: sessionId,
      trackId: oldTrackId,
      generationRequestId: oldRequestId,
      position: 0,
      state: 'queued',
    });

    const { provider, calls } = countingMusicProvider(async (_input, n) => okTask(`play-out-${n}`));
    const result = await runEnsureSessionBuffer(
      {
        db: ctx.db,
        music: provider,
        now: NOW,
        limits: ampleLimits(),
        stallThresholdMs: NEVER_STALE,
      },
      { sessionId },
    );

    expect(result.action).toBe('generate');
    expect(calls()).toBe(1);
    expect((await sessionRequests(sessionId)).at(-1)).toMatchObject({
      styleRevision: 2,
      targetBpm: 70,
      targetKey: 'C major',
    });
  });

  it('an armed vibe switch treats old-revision buffered tracks as no supply and submits the new vibe', async () => {
    // Revision-2 session with an armed switch and a FULL buffer (3 queued
    // revision-1 tracks) — which without the switch suppresses every top-up.
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      sessionMode: 'repeat',
      styleSnapshot: { stylePrompt: 'ambient piano', bpm: 70, key: 'C major' },
    });
    await ctx.db
      .update(activitySessions)
      .set({ styleRevision: 2, vibeSwitchRevision: 2 })
      .where(eq(activitySessions.id, sessionId));
    const oldRequestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      styleRevision: 1,
    });
    const oldJobId = await createProviderJob(ctx.db, {
      generationRequestId: oldRequestId,
      submitState: 'submitted',
      normalizedStatus: 'ready',
      createdAt: NOW,
    });
    for (let i = 0; i < 3; i += 1) {
      const trackId = await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: oldRequestId,
        providerJobId: oldJobId,
        providerTrackId: `old-vibe-${i}`,
        status: 'ready',
      });
      await createQueueItem(ctx.db, {
        activitySessionId: sessionId,
        trackId,
        generationRequestId: oldRequestId,
        position: i,
        state: 'queued',
      });
    }

    const { provider, calls } = countingMusicProvider(async (_input, n) => okTask(`switch-${n}`));
    const result = await runEnsureSessionBuffer(
      {
        db: ctx.db,
        music: provider,
        now: NOW,
        limits: ampleLimits(),
        stallThresholdMs: NEVER_STALE,
      },
      { sessionId },
    );
    expect(result.action).toBe('generate');
    expect(calls()).toBe(1);
    const requests = await sessionRequests(sessionId);
    expect(requests.at(-1)).toMatchObject({
      styleRevision: 2,
      targetBpm: 70,
      targetKey: 'C major',
    });

    // Once the current revision has a request, disarming the switch and exposing
    // the old-vibe Queue again must not submit a duplicate new-vibe request.
    await ctx.db
      .update(activitySessions)
      .set({ vibeSwitchRevision: null })
      .where(eq(activitySessions.id, sessionId));
    // Complete the switch submit's job so no current-revision work remains in flight.
    await ctx.db
      .update(providerJobs)
      .set({ normalizedStatus: 'ready' })
      .where(eq(providerJobs.providerTaskId, 'switch-1'));
    const again = await runEnsureSessionBuffer(
      {
        db: ctx.db,
        music: provider,
        now: NOW,
        limits: ampleLimits(),
        stallThresholdMs: NEVER_STALE,
      },
      { sessionId },
    );
    // Repeat mode loops the session's own tracks instead of topping up — the
    // point is the money assertion: no duplicate new-vibe submit.
    expect(again.action).toBe('voluntary_repeat');
    expect(calls()).toBe(1);
  });

  it('a pending reroll of a vibe a Change Vibe replaced buys nothing; the revision fill generates', async () => {
    // After a Change Vibe an old-vibe reroll is cancelled, never submitted ahead
    // of (or after) the new vibe.
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: { stylePrompt: 'ambient piano', bpm: 70, key: 'C major' },
    });
    const oldRequestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      styleRevision: 1,
      stylePrompt: 'instrumental lofi',
      styleSnapshot: { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' },
    });
    const oldJobId = await createProviderJob(ctx.db, {
      generationRequestId: oldRequestId,
      submitState: 'submitted',
      normalizedStatus: 'ready',
      createdAt: NOW,
    });
    const dislikedTrackId = await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: oldRequestId,
      providerJobId: oldJobId,
      providerTrackId: 'disliked-old-vibe',
      status: 'rejected',
      dislikedAt: NOW,
      rerollPendingAt: NOW,
    });
    await ctx.db
      .update(activitySessions)
      .set({ styleRevision: 2 })
      .where(eq(activitySessions.id, sessionId));

    let submittedInput: MusicGenerationInput | undefined;
    const { provider, calls } = countingMusicProvider(async (input, n) => {
      submittedInput = input;
      return okTask(`stale-reroll-${n}`);
    });
    const result = await runEnsureSessionBuffer(
      {
        db: ctx.db,
        music: provider,
        now: NOW,
        limits: ampleLimits(),
        stallThresholdMs: NEVER_STALE,
      },
      { sessionId },
    );

    expect(result.action).toBe('generate');
    expect(calls()).toBe(1);
    const requests = await sessionRequests(sessionId);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ styleRevision: 2, targetBpm: 70, targetKey: 'C major' });
    expect(submittedInput?.style).toContain('ambient piano');
    expect(submittedInput?.style).not.toContain('instrumental lofi');
    // Cancelled, not deferred: no later tick can buy the old vibe.
    expect((await rawTrackRow(ctx.db, dislikedTrackId))?.reroll_pending_at).toBeNull();
  });

  it('an armed switch with the new vibe already in flight does not double-submit', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: { stylePrompt: 'ambient piano', bpm: 70, key: 'C major' },
    });
    await ctx.db
      .update(activitySessions)
      .set({ styleRevision: 2, vibeSwitchRevision: 2 })
      .where(eq(activitySessions.id, sessionId));
    // The new-vibe submit is already in flight (revision 2, processing).
    const newRequestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      styleRevision: 2,
    });
    await createProviderJob(ctx.db, {
      generationRequestId: newRequestId,
      submitState: 'submitted',
      normalizedStatus: 'processing',
      createdAt: NOW,
    });

    const { provider, calls } = countingMusicProvider(async (_input, n) => okTask(`dup-${n}`));
    const result = await runEnsureSessionBuffer(
      {
        db: ctx.db,
        music: provider,
        now: NOW,
        limits: ampleLimits(),
        stallThresholdMs: NEVER_STALE,
      },
      { sessionId },
    );
    expect(result.action).toBe('noop');
    expect(calls()).toBe(0);
  });

  it('drops a reroll of the policy-blocked style so the Change Vibe fill generates', async () => {
    // The provider blocked the OLD style; the user Changed Vibe (new live style)
    // and disliked an old-vibe track. The reroll would resubmit the BLOCKED
    // style, which no clock ever lifts — it must neither be paid for nor starve
    // the new vibe the block copy advises.
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: { stylePrompt: 'the new safe vibe', bpm: 70, key: 'C major' },
    });
    const blockedRequest = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      stylePrompt: 'the old, provider-blocked style',
      styleRevision: 1,
      targetBpm: 96,
      targetKey: 'A minor',
    });
    const blockedJob = await createProviderJob(ctx.db, {
      generationRequestId: blockedRequest,
      normalizedStatus: 'blocked_by_policy',
      createdAt: NOW,
      updatedAt: new Date(NOW.getTime() - 60 * 60_000),
    });
    const dislikedTrackId = await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: blockedRequest,
      providerJobId: blockedJob,
      status: 'rejected',
      dislikedAt: NOW,
      rerollPendingAt: NOW,
    });
    const { provider, calls } = countingMusicProvider(async () => okTask('mock-new-vibe'));

    const result = await runEnsureSessionBuffer(
      { db: ctx.db, music: provider, now: NOW, limits: ampleLimits() },
      { sessionId },
    );

    expect(result.action).toBe('generate');
    expect(calls()).toBe(1);
    const submitted = (await sessionRequests(sessionId)).at(-1);
    expect(submitted?.stylePrompt).not.toBe('the old, provider-blocked style');
    const row = await rawTrackRow(ctx.db, dislikedTrackId);
    expect(row?.reroll_pending_at).toBeNull();
  });

  it('a policy block on the LIVE style does not suppress a safe old-vibe reroll', async () => {
    // The CURRENT vibe is blocked, but the pending reroll resubmits a different,
    // previously accepted old style — the block comparison runs against what
    // would actually submit, so the safe reroll proceeds.
    const ownerUserId = await createUser(ctx.db);
    const liveSnapshot = { stylePrompt: 'the blocked live vibe', bpm: 70, key: 'C major' };
    const sessionId = await createSession(ctx.db, { ownerUserId, styleSnapshot: liveSnapshot });
    const liveStyle = buildSessionStyle(sessionStyleSnapshotSchema.parse(liveSnapshot));

    // The OLD, safe request whose track was disliked (older job, completed).
    const safeRequest = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      stylePrompt: 'the old safe style, 96 bpm, A minor',
      styleRevision: 1,
      targetBpm: 96,
      targetKey: 'A minor',
    });
    const safeJob = await createProviderJob(ctx.db, {
      generationRequestId: safeRequest,
      normalizedStatus: 'ready',
      createdAt: new Date(NOW.getTime() - 10 * 60_000),
    });
    await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: safeRequest,
      providerJobId: safeJob,
      status: 'rejected',
      dislikedAt: NOW,
      rerollPendingAt: NOW,
    });
    // The LATEST job: the current live style, blocked by policy.
    const blockedRequest = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      stylePrompt: liveStyle,
    });
    await createProviderJob(ctx.db, {
      generationRequestId: blockedRequest,
      normalizedStatus: 'blocked_by_policy',
      createdAt: NOW,
    });

    let submittedInput: MusicGenerationInput | undefined;
    const { provider, calls } = countingMusicProvider(async (input, n) => {
      submittedInput = input;
      return okTask(`mock-safe-reroll-${n}`);
    });

    const result = await runEnsureSessionBuffer(
      { db: ctx.db, music: provider, now: NOW, limits: ampleLimits() },
      { sessionId },
    );

    expect(result.action).toBe('generate');
    expect(calls()).toBe(1);
    expect(submittedInput?.style).toContain('the old safe style');
    expect(submittedInput?.style).not.toContain('the blocked live vibe');
  });

  it('a LEGACY reroll (no stored snapshot) still keeps the old vibe via the stored style', async () => {
    // A legacy-shaped request: style identity persisted, but NO compilation
    // snapshot (its old prompt is only partially recoverable).
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: { stylePrompt: 'ambient piano', bpm: 70, key: 'C major' }, // the NEW vibe
    });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      stylePrompt: 'old vibe lofi, 96 bpm, A minor',
      styleRevision: 1,
      targetBpm: 96,
      targetKey: 'A minor',
    });
    const jobId = await createProviderJob(ctx.db, {
      generationRequestId: requestId,
      normalizedStatus: 'ready',
    });
    await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      status: 'rejected',
      dislikedAt: NOW,
      rerollPendingAt: NOW,
    });

    let submittedInput: MusicGenerationInput | undefined;
    const { provider } = countingMusicProvider(async (input, n) => {
      submittedInput = input;
      return okTask(`mock-legacy-reroll-${n}`);
    });
    const result = await runEnsureSessionBuffer(
      {
        db: ctx.db,
        music: provider,
        now: NOW,
        limits: ampleLimits(),
        stallThresholdMs: NEVER_STALE,
      },
      { sessionId },
    );

    expect(result.action).toBe('generate');
    // The degraded legacy path: the stored style verbatim (old vibe, old tail),
    // never the live snapshot — and custom mode still gets a title.
    expect(submittedInput?.style).toBe('old vibe lofi, 96 bpm, A minor');
    expect(submittedInput?.style).not.toContain('ambient piano');
    expect(submittedInput?.title).toBeTruthy();
    const requests = await sessionRequests(sessionId);
    expect(requests[1]).toMatchObject({ styleRevision: 1, targetBpm: 96, targetKey: 'A minor' });
  });

  // --- Session mode vs owner Buffer default: the mode alone decides top-ups ----

  describe('Session mode and the owner Buffer default', () => {
    /** A rejected Track of a seeded Session carrying a pending fresh-call reroll intent. */
    async function seedPendingReroll(seed: {
      ownerUserId: string;
      requestId: string;
      providerJobId: string;
    }): Promise<void> {
      await createTrack(ctx.db, {
        ownerUserId: seed.ownerUserId,
        generationRequestId: seed.requestId,
        providerJobId: seed.providerJobId,
        providerTrackId: 'disliked',
        status: 'rejected',
        dislikedAt: NOW,
        rerollPendingAt: NOW,
      });
    }

    async function pendingRerollCount(sessionId: string): Promise<number> {
      const rows = await ctx.db
        .select({ id: tracks.id })
        .from(tracks)
        .innerJoin(generationRequests, eq(tracks.generationRequestId, generationRequests.id))
        .where(
          and(
            eq(generationRequests.activitySessionId, sessionId),
            isNotNull(tracks.rerollPendingAt),
          ),
        );
      return rows.length;
    }

    it('cancels a pending reroll in Repeat mode and submits nothing', async () => {
      // Switching to "Play existing Tracks" means STOP generating, not defer —
      // an intent left dormant would hijack the next legitimate generate.
      const seed = await seedSessionWithOwnTracks(2);
      const { sessionId } = seed;
      await seedPendingReroll(seed);
      await switchToRepeatMode(sessionId);

      const deps = { db: ctx.db, music, now: NOW, limits: ampleLimits() };
      const result = await runEnsureSessionBuffer(deps, { sessionId });

      expect(result.action).toBe('voluntary_repeat');
      expect(await sessionJobs(sessionId)).toHaveLength(1); // no new paid job
      expect(await pendingRerollCount(sessionId)).toBe(0);

      // Cancelled stays cancelled: switching back must not resurrect the reroll.
      await ctx.db
        .update(activitySessions)
        .set({ sessionMode: 'keep_going' })
        .where(eq(activitySessions.id, sessionId));
      const resumed = await runEnsureSessionBuffer(deps, { sessionId });
      // The top-up (this session is below its watermark) is what generates now,
      // and it compiles the LIVE snapshot rather than the disliked Track's.
      expect(resumed.action).toBe('generate');
      expect((await sessionRequests(sessionId))[1]).toMatchObject({ styleRevision: 1 });
      expect(await pendingRerollCount(sessionId)).toBe(0);
    });

    it('a Keep Going session still submits and consumes its pending reroll', async () => {
      const seed = await seedSessionWithOwnTracks(2);
      const { sessionId } = seed;
      await seedPendingReroll(seed);

      const result = await runEnsureSessionBuffer(
        { db: ctx.db, music, now: NOW, limits: ampleLimits() },
        { sessionId },
      );

      expect(result.action).toBe('generate');
      expect(await pendingRerollCount(sessionId)).toBe(0);
      expect(await sessionJobs(sessionId)).toHaveLength(2);
    });

    it('Repeat mode stops topping up and loops the session’s own tracks', async () => {
      // One prior (fully delivered) request, nothing ready ahead — Keep Going
      // would top up here; Repeat means "play existing Tracks", so the
      // controller loops instead (the player wraps on `sessionMode='repeat'`).
      const { sessionId } = await seedSessionWithOwnTracks(2);
      await switchToRepeatMode(sessionId);

      const result = await runEnsureSessionBuffer(
        { db: ctx.db, music, now: NOW, limits: ampleLimits(), stallThresholdMs: NEVER_STALE },
        { sessionId },
      );

      expect(result.action).toBe('voluntary_repeat');
      expect(result.generationStatus).toBe('ok');
      expect(result.loopTrackIds).toHaveLength(2);
      expect(await sessionJobs(sessionId)).toHaveLength(1); // no new paid job
      expect(await sessionStatus(sessionId)).toEqual({
        status: 'active', // a controller status, never a lifecycle change
        generationStatus: 'ok',
        statusMessageSafe: null,
      });
    });

    it('Repeat mode still performs the cold-start initial fill', async () => {
      const { sessionId } = await freshGeneratingSession();
      await switchToRepeatMode(sessionId);

      const deps = { db: ctx.db, music, now: NOW, limits: ampleLimits() };
      const result = await runEnsureSessionBuffer(deps, { sessionId });

      expect(result.action).toBe('generate');
      expect(result.submittedTaskId).toBeTruthy();

      const whileInFlight = await runEnsureSessionBuffer(deps, { sessionId });
      expect(whileInFlight).toMatchObject({ action: 'noop', generationStatus: 'ok' });
      expect(await sessionJobs(sessionId)).toHaveLength(1);
    });

    it('Keep Going tops up even while the owner Buffer default is off', async () => {
      // Three ready-ahead queue items satisfy the shipped default (top up when
      // below 2) but sit below a configured buffer of 6 (top up when below 5).
      // `bufferEnabled` is only the default mode for NEW sessions — it must not
      // block this session's explicit Keep Going mode.
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, {
        ownerUserId,
        styleSnapshot: { stylePrompt: 'instrumental lofi', bpm: 96, key: 'A minor' },
      });
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
      for (let i = 0; i < 3; i += 1) {
        const trackId = await createTrack(ctx.db, {
          ownerUserId,
          generationRequestId: requestId,
          providerJobId: jobId,
          providerTrackId: `ahead-${i}`,
          status: 'ready',
        });
        await createQueueItem(ctx.db, {
          activitySessionId: sessionId,
          trackId,
          generationRequestId: requestId,
          position: i,
        });
      }

      await updateGenerationSettings(ctx.db, {
        ownerUserId,
        patch: { bufferEnabled: false, bufferAheadTracks: 6 },
      });
      const deps = { db: ctx.db, music, now: NOW, limits: ampleLimits() };
      expect((await runEnsureSessionBuffer(deps, { sessionId })).action).toBe('generate');

      // Switching the session to Repeat is what stops the top-ups — live, on
      // the next tick.
      await switchToRepeatMode(sessionId);
      expect((await runEnsureSessionBuffer(deps, { sessionId })).action).toBe('voluntary_repeat');
      expect(await sessionJobs(sessionId)).toHaveLength(2);
    });
  });

  describe('own-voice submits (user voice feature)', () => {
    const OWN_VOICE_SNAPSHOT = {
      stylePrompt: 'dream pop, with vocals',
      vocalMode: 'vocal' as const,
      useOwnVoice: true,
      bpm: 96,
      key: 'A minor',
    };

    async function seedOwnVoiceSession(
      styleSnapshot: Record<string, unknown> = OWN_VOICE_SNAPSHOT,
    ): Promise<{ ownerUserId: string; sessionId: string }> {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, styleSnapshot });
      return { ownerUserId, sessionId };
    }

    async function seedReadyVoiceProfile(ownerUserId: string): Promise<void> {
      await ctx.db.insert(voiceProfiles).values({
        ownerUserId,
        providerKey: 'mock',
        status: 'ready',
        providerVoiceId: 'voice-ref-1',
        consentVersion: 'v1',
        consentAcceptedAt: NOW,
      });
    }

    it('attaches the resolved provider voice reference to an own-voice submit', async () => {
      const { ownerUserId, sessionId } = await seedOwnVoiceSession();
      await seedReadyVoiceProfile(ownerUserId);
      const inputs: MusicGenerationInput[] = [];
      const { provider } = countingMusicProvider(async (input, count) => {
        inputs.push(input);
        return okTask(`own-voice-${count}`);
      });

      const result = await runEnsureSessionBuffer(
        { db: ctx.db, music: provider, now: NOW, limits: ampleLimits() },
        { sessionId },
      );

      expect(result.action).toBe('generate');
      expect(result.submittedTaskId).toBe('own-voice-1');
      expect(inputs[0]?.customVoice).toEqual({ providerVoiceId: 'voice-ref-1' });
      const [profile] = await ctx.db.select().from(voiceProfiles);
      expect(profile?.lastUsedAt).not.toBeNull();
    });

    it('budgets own-voice submits and their rerolls against the persona model style cap', async () => {
      // Default model V4 (200-char style) while own voice pins a 1000-char
      // model: the vocal tail's long lyric brief must not crowd out the genre.
      const snapshot = {
        ...OWN_VOICE_SNAPSHOT,
        stylePrompt: 'synth-pop, glossy analog pads',
        language: 'German',
        lyricContext: 'l'.repeat(180),
      };
      const fresh = await seedOwnVoiceSession(snapshot);
      await seedReadyVoiceProfile(fresh.ownerUserId);
      const { ownerUserId, sessionId: rerollSessionId } = await seedOwnVoiceSession(snapshot);
      await seedReadyVoiceProfile(ownerUserId);
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: rerollSessionId,
        styleSnapshot: snapshot,
      });
      const jobId = await createProviderJob(ctx.db, {
        generationRequestId: requestId,
        submitState: 'submitted',
        normalizedStatus: 'ready',
        createdAt: NOW,
      });
      await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
        status: 'rejected',
        dislikedAt: NOW,
        rerollPendingAt: NOW,
      });
      const inputs: MusicGenerationInput[] = [];
      const counting = countingMusicProvider(async (input, count) => {
        inputs.push(input);
        return okTask(`own-voice-${count}`);
      });
      const provider: MusicProvider = {
        ...counting.provider,
        getCapabilities: () => {
          const caps = counting.provider.getCapabilities();
          return {
            ...caps,
            maxStyleLength: 200,
            customVoice: { ...caps.customVoice!, maxStyleLength: 1000 },
          };
        },
      };
      const deps = {
        db: ctx.db,
        music: provider,
        now: NOW,
        limits: ampleLimits(),
        stallThresholdMs: NEVER_STALE,
      };

      for (const sessionId of [fresh.sessionId, rerollSessionId]) {
        expect((await runEnsureSessionBuffer(deps, { sessionId })).action).toBe('generate');
      }

      expect(inputs).toHaveLength(2);
      for (const input of inputs) {
        expect(input.customVoice).toEqual({ providerVoiceId: 'voice-ref-1' });
        expect(input.style).toContain('synth-pop');
      }
    });

    it('blocks an own-voice submit with NO ready profile — zero spend, safe status', async () => {
      const { sessionId } = await seedOwnVoiceSession();
      const { provider, calls } = countingMusicProvider(async () => okTask('never'));

      const result = await runEnsureSessionBuffer(
        { db: ctx.db, music: provider, now: NOW, limits: ampleLimits() },
        { sessionId },
      );

      expect(result).toEqual({ action: 'wait', generationStatus: 'provider_error' });
      expect(calls()).toBe(0);
      expect(await sessionJobs(sessionId)).toHaveLength(0);
      expect((await sessionStatus(sessionId)).generationStatus).toBe('provider_error');
    });

    it('blocks a disabled profile and a provider without customVoice support alike', async () => {
      const { ownerUserId, sessionId } = await seedOwnVoiceSession();
      await ctx.db.insert(voiceProfiles).values({
        ownerUserId,
        providerKey: 'mock',
        status: 'disabled',
        providerVoiceId: 'voice-ref-1',
        consentVersion: 'v1',
        consentAcceptedAt: NOW,
      });
      const { provider, calls } = countingMusicProvider(async () => okTask('never'));
      const disabled = await runEnsureSessionBuffer(
        { db: ctx.db, music: provider, now: NOW, limits: ampleLimits() },
        { sessionId },
      );
      expect(disabled.generationStatus).toBe('provider_error');
      expect(calls()).toBe(0);

      // Ready profile, but the provider cannot sing with custom voices.
      await ctx.db
        .update(voiceProfiles)
        .set({ status: 'ready' })
        .where(eq(voiceProfiles.ownerUserId, ownerUserId));
      const { provider: unsupported, calls: unsupportedCalls } = (() => {
        const counting = countingMusicProvider(async () => okTask('never'));
        const base = counting.provider;
        const provider: MusicProvider = {
          ...base,
          getCapabilities: () => {
            const { customVoice: _dropped, ...caps } = base.getCapabilities();
            return caps;
          },
        };
        return { provider, calls: counting.calls };
      })();
      const blocked = await runEnsureSessionBuffer(
        { db: ctx.db, music: unsupported, now: NOW, limits: ampleLimits() },
        { sessionId },
      );
      expect(blocked.generationStatus).toBe('provider_error');
      expect(unsupportedCalls()).toBe(0);
    });

    it('drops an own-voice reroll that cannot sing so a generic-vocals Change Vibe still generates', async () => {
      // The block copy advises Change Vibe to generic vocals; the reroll-first
      // planner must not keep serving the old own-voice intent ahead of it.
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, {
        ownerUserId,
        styleSnapshot: { ...OWN_VOICE_SNAPSHOT, useOwnVoice: false },
      });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
        styleSnapshot: OWN_VOICE_SNAPSHOT,
      });
      const jobId = await createProviderJob(ctx.db, {
        generationRequestId: requestId,
        submitState: 'submitted',
        normalizedStatus: 'ready',
        createdAt: NOW,
      });
      await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
        status: 'rejected',
        dislikedAt: NOW,
        rerollPendingAt: NOW,
      });
      const inputs: MusicGenerationInput[] = [];
      const { provider } = countingMusicProvider(async (input, count) => {
        inputs.push(input);
        return okTask(`generic-${count}`);
      });

      const result = await runEnsureSessionBuffer(
        {
          db: ctx.db,
          music: provider,
          now: NOW,
          limits: ampleLimits(),
          stallThresholdMs: NEVER_STALE,
        },
        { sessionId },
      );

      expect(result.action).toBe('generate');
      expect(inputs[0]?.customVoice).toBeUndefined();
    });

    it('a generic-vocals session is untouched by voice-profile state (no gate)', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, {
        ownerUserId,
        styleSnapshot: { ...OWN_VOICE_SNAPSHOT, useOwnVoice: false },
      });
      const inputs: MusicGenerationInput[] = [];
      const { provider } = countingMusicProvider(async (input, count) => {
        inputs.push(input);
        return okTask(`generic-${count}`);
      });
      const result = await runEnsureSessionBuffer(
        { db: ctx.db, music: provider, now: NOW, limits: ampleLimits() },
        { sessionId },
      );
      expect(result.action).toBe('generate');
      expect(inputs[0]?.customVoice).toBeUndefined();
    });
  });

  describe('per-generation track lyric brief', () => {
    const LYRIC_NOTES = 'people: Ana; setting: coastal drive at dusk';
    const VOCAL_SNAPSHOT = {
      stylePrompt: 'dream pop, with vocals',
      vocalMode: 'vocal' as const,
      lyricContext: LYRIC_NOTES,
      language: 'English',
      mood: 'wistful',
      bpm: 96,
      key: 'A minor',
    };
    /** The mock LLM's brief for a session with no prior generations — the just-
     *  committed intent row is excluded from the variety memory, so the first
     *  call sees an empty `previousBriefs`. */
    const FIRST_BRIEF = `focus 1: ${LYRIC_NOTES}`;

    async function seedVocalSession(
      snapshot: Record<string, unknown> = VOCAL_SNAPSHOT,
    ): Promise<{ ownerUserId: string; sessionId: string }> {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, {
        ownerUserId,
        styleSnapshot: snapshot,
        userPrompt: 'a song for Ana',
      });
      return { ownerUserId, sessionId };
    }

    /** The mock LLM with `createTrackLyricBrief` inputs captured (and optionally overridden). */
    function capturingLlm(impl?: (input: TrackLyricBriefInput) => Promise<string>): {
      llm: LlmProvider;
      briefCalls: TrackLyricBriefInput[];
    } {
      const base = mockLlmProvider();
      const briefCalls: TrackLyricBriefInput[] = [];
      const llm: LlmProvider = {
        ...base,
        async createTrackLyricBrief(input) {
          briefCalls.push(input);
          return impl ? impl(input) : base.createTrackLyricBrief(input);
        },
      };
      return { llm, briefCalls };
    }

    function capturingMusic(taskPrefix: string): {
      provider: MusicProvider;
      inputs: MusicGenerationInput[];
    } {
      const inputs: MusicGenerationInput[] = [];
      const { provider } = countingMusicProvider(async (input, count) => {
        inputs.push(input);
        return okTask(`${taskPrefix}-${count}`);
      });
      return { provider, inputs };
    }

    function briefDeps(provider: MusicProvider, llm: LlmProvider | null | undefined) {
      return {
        db: ctx.db,
        music: provider,
        now: NOW,
        limits: ampleLimits(),
        stallThresholdMs: NEVER_STALE,
        ...(llm !== undefined ? { getLlm: async () => llm } : {}),
      };
    }

    /** The lyricContext frozen on the session's first generation request — what a
     *  Dislike reroll of that request would re-compile from. */
    async function frozenLyricContext(sessionId: string): Promise<unknown> {
      const [request] = await sessionRequests(sessionId);
      return (request!.styleSnapshot as Record<string, unknown>).lyricContext;
    }

    async function liveSessionLyricContext(sessionId: string): Promise<unknown> {
      const [row] = await ctx.db
        .select({ snapshot: activitySessions.sessionStyleSnapshot })
        .from(activitySessions)
        .where(eq(activitySessions.id, sessionId));
      return (row!.snapshot as Record<string, unknown>).lyricContext;
    }

    /** Complete the session's single in-flight job so the next tick generates again. */
    async function completeSessionJobs(sessionId: string): Promise<void> {
      const jobs = await ctx.db
        .select({ id: providerJobs.id })
        .from(providerJobs)
        .innerJoin(generationRequests, eq(providerJobs.generationRequestId, generationRequests.id))
        .where(eq(generationRequests.activitySessionId, sessionId));
      for (const job of jobs) {
        await ctx.db
          .update(providerJobs)
          .set({ normalizedStatus: 'ready' })
          .where(eq(providerJobs.id, job.id));
      }
    }

    it('injects a fresh brief on a fresh vocal submit — provider input and frozen row agree', async () => {
      const { sessionId } = await seedVocalSession();
      const { provider, inputs } = capturingMusic('inject');
      const { llm, briefCalls } = capturingLlm();

      const result = await runEnsureSessionBuffer(briefDeps(provider, llm), { sessionId });

      expect(result.action).toBe('generate');
      expect(result.submittedTaskId).toBe('inject-1');
      expect(briefCalls).toHaveLength(1);
      expect(briefCalls[0]).toMatchObject({
        lyricContext: LYRIC_NOTES,
        language: 'English',
        stylePrompt: 'dream pop, with vocals',
        mood: 'wistful',
        userPrompt: 'a song for Ana',
      });

      // Submitted and stored stay identical: the description tail and the
      // own-voice lyrics field carry the brief, and the request row's frozen
      // snapshot carries the same brief (what a future reroll re-compiles).
      expect(inputs[0]?.prompt).toContain(`. Lyric brief: ${FIRST_BRIEF}`);
      expect(inputs[0]?.lyricBrief).toBe(FIRST_BRIEF);
      expect(await frozenLyricContext(sessionId)).toBe(FIRST_BRIEF);

      // The session's LIVE snapshot keeps the base notes — the brief is per-generation.
      expect(await liveSessionLyricContext(sessionId)).toBe(LYRIC_NOTES);
    });

    it("feeds the previous generation's brief into the next brief call (variety memory)", async () => {
      const { sessionId } = await seedVocalSession();
      const first = capturingMusic('mem-first');
      await runEnsureSessionBuffer(briefDeps(first.provider, capturingLlm().llm), { sessionId });
      await completeSessionJobs(sessionId);

      const second = capturingMusic('mem-second');
      const { llm, briefCalls } = capturingLlm();
      await runEnsureSessionBuffer(briefDeps(second.provider, llm), { sessionId });

      expect(briefCalls).toHaveLength(1);
      // Exactly the prior generation's brief: the second submit's own committed
      // row (still carrying the base notes) never occupies a memory slot.
      expect(briefCalls[0]!.previousBriefs).toEqual([FIRST_BRIEF]);
    });

    it("clamps an overlong brief at the snapshot slot's boundary — stored and submitted agree", async () => {
      const { sessionId } = await seedVocalSession();
      const { provider, inputs } = capturingMusic('long-brief');
      const { llm } = capturingLlm(async () => 'x'.repeat(600));

      const result = await runEnsureSessionBuffer(briefDeps(provider, llm), { sessionId });

      expect(result.action).toBe('generate');
      const clamped = 'x'.repeat(500);
      expect(inputs[0]?.lyricBrief).toBe(clamped);
      expect(await frozenLyricContext(sessionId)).toBe(clamped);
    });

    it('a reroll submit never calls the text LLM and reuses its frozen brief', async () => {
      const frozenBrief = 'focus 2: harbor lights; a promise kept';
      const { ownerUserId, sessionId } = await seedVocalSession();
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
        stylePrompt: 'dream pop, with vocals, 96 bpm, A minor',
        styleRevision: 1,
        targetBpm: 96,
        targetKey: 'A minor',
        styleSnapshot: { ...VOCAL_SNAPSHOT, lyricContext: frozenBrief },
      });
      const jobId = await createProviderJob(ctx.db, {
        generationRequestId: requestId,
        submitState: 'submitted',
        normalizedStatus: 'ready',
        createdAt: NOW,
      });
      await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
        status: 'rejected',
        dislikedAt: NOW,
        rerollPendingAt: NOW,
      });
      const { provider, inputs } = capturingMusic('reroll-brief');
      const { llm, briefCalls } = capturingLlm();

      const result = await runEnsureSessionBuffer(briefDeps(provider, llm), { sessionId });

      expect(result.action).toBe('generate');
      expect(briefCalls).toHaveLength(0);
      expect(inputs[0]?.lyricBrief).toBe(frozenBrief);
    });

    it('gates: instrumental, empty lyric notes, and no resolved LLM all submit statically', async () => {
      // Instrumental session — a configured LLM is never consulted.
      const instrumental = await freshGeneratingSession();
      const instrumentalLlm = capturingLlm();
      const instrumentalDeps = briefDeps(
        capturingMusic('gate-instr').provider,
        instrumentalLlm.llm,
      );
      await runEnsureSessionBuffer(instrumentalDeps, { sessionId: instrumental.sessionId });
      expect(instrumentalLlm.briefCalls).toHaveLength(0);

      // Vocal session without lyric notes — nothing to extend, no call.
      const noNotes = await seedVocalSession({ ...VOCAL_SNAPSHOT, lyricContext: '' });
      const noNotesMusic = capturingMusic('gate-nonotes');
      const noNotesLlm = capturingLlm();
      await runEnsureSessionBuffer(briefDeps(noNotesMusic.provider, noNotesLlm.llm), {
        sessionId: noNotes.sessionId,
      });
      expect(noNotesLlm.briefCalls).toHaveLength(0);
      expect(noNotesMusic.inputs[0]?.lyricBrief).toBeUndefined();

      // Vocal session with notes but no resolved LLM — static submit, row keeps the notes.
      const unresolved = await seedVocalSession();
      const unresolvedMusic = capturingMusic('gate-nollm');
      const result = await runEnsureSessionBuffer(briefDeps(unresolvedMusic.provider, null), {
        sessionId: unresolved.sessionId,
      });
      expect(result.action).toBe('generate');
      expect(unresolvedMusic.inputs[0]?.lyricBrief).toBe(LYRIC_NOTES);
      expect(await frozenLyricContext(unresolved.sessionId)).toBe(LYRIC_NOTES);
    });

    it("an empty brief ('') submits the static compile, warns, and leaves the row untouched", async () => {
      const { sessionId } = await seedVocalSession();
      const { provider, inputs } = capturingMusic('empty-brief');
      const { llm, briefCalls } = capturingLlm(async () => '');
      const warnings: string[] = [];

      const result = await runEnsureSessionBuffer(
        { ...briefDeps(provider, llm), warn: (message) => warnings.push(message) },
        { sessionId },
      );

      expect(result.action).toBe('generate');
      expect(result.submittedTaskId).toBe('empty-brief-1');
      expect(briefCalls).toHaveLength(1);
      expect(inputs[0]?.lyricBrief).toBe(LYRIC_NOTES);
      expect(inputs[0]?.prompt).toContain(`. Lyric brief: ${LYRIC_NOTES}`);
      expect(await frozenLyricContext(sessionId)).toBe(LYRIC_NOTES);
      expect(warnings.some((message) => message.includes('track lyric brief unavailable'))).toBe(
        true,
      );
    });

    it('a throwing brief dep still submits the static compile — generation never blocks', async () => {
      const { sessionId } = await seedVocalSession();
      const { provider, inputs } = capturingMusic('throw-brief');
      const { llm } = capturingLlm(async () => {
        throw new Error('llm outage');
      });
      const warnings: string[] = [];

      const result = await runEnsureSessionBuffer(
        { ...briefDeps(provider, llm), warn: (message) => warnings.push(message) },
        { sessionId },
      );

      expect(result.action).toBe('generate');
      expect(result.submittedTaskId).toBe('throw-brief-1');
      expect(inputs[0]?.lyricBrief).toBe(LYRIC_NOTES);
      expect(await frozenLyricContext(sessionId)).toBe(LYRIC_NOTES);
      expect(warnings.some((message) => message.includes('lyric brief'))).toBe(true);
    });

    it('logs a failed brief without the error message, which can carry the lyric notes', async () => {
      const { sessionId } = await seedVocalSession();
      const { llm } = capturingLlm(async () => {
        throw new Error(`Failed query: update … params: ${LYRIC_NOTES}`);
      });
      const logged: unknown[] = [];

      await runEnsureSessionBuffer(
        {
          ...briefDeps(capturingMusic('leak-brief').provider, llm),
          warn: (message, fields) => logged.push(message, fields),
        },
        { sessionId },
      );

      expect(logged.length).toBeGreaterThan(0);
      expect(JSON.stringify(logged)).not.toContain(LYRIC_NOTES);
    });

    it("a brief never changes the request's stored style identity (policy-block comparison)", async () => {
      const briefed = await seedVocalSession();
      const briefedDeps = briefDeps(capturingMusic('identity-a').provider, capturingLlm().llm);
      await runEnsureSessionBuffer(briefedDeps, { sessionId: briefed.sessionId });

      const unbriefed = await seedVocalSession();
      await runEnsureSessionBuffer(briefDeps(capturingMusic('identity-b').provider, undefined), {
        sessionId: unbriefed.sessionId,
      });

      const [briefedRequest] = await sessionRequests(briefed.sessionId);
      const [unbriefedRequest] = await sessionRequests(unbriefed.sessionId);
      expect(briefedRequest!.stylePrompt).toBe(unbriefedRequest!.stylePrompt);
      expect(briefedRequest!.stylePrompt).toContain('dream pop');
    });
  });
  describe('track-title pool refill', () => {
    const POOL_SNAPSHOT = {
      stylePrompt: 'instrumental lofi',
      bpm: 96,
      key: 'A minor',
      mood: 'mellow',
      title: 'Night Shift',
      trackTitles: ['Neon Harbor'],
    };

    /** The mock LLM with `createTrackTitles` inputs captured (and optionally overridden). */
    function titlesLlm(impl?: (input: TrackTitlesInput) => Promise<string[]>): {
      llm: LlmProvider;
      titleCalls: TrackTitlesInput[];
    } {
      const base = mockLlmProvider();
      const titleCalls: TrackTitlesInput[] = [];
      const llm: LlmProvider = {
        ...base,
        async createTrackTitles(input) {
          titleCalls.push(input);
          return impl ? impl(input) : base.createTrackTitles(input);
        },
      };
      return { llm, titleCalls };
    }

    function titleDeps(llm: LlmProvider) {
      return {
        db: ctx.db,
        music: countingMusicProvider(async () => okTask(`mock-titles-${crypto.randomUUID()}`))
          .provider,
        now: NOW,
        limits: ampleLimits(),
        stallThresholdMs: NEVER_STALE,
        getLlm: async () => llm,
      };
    }

    async function seedPoolSession(trackTitles: string[]): Promise<{
      ownerUserId: string;
      sessionId: string;
    }> {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, {
        ownerUserId,
        styleSnapshot: { ...POOL_SNAPSHOT, trackTitles },
        userPrompt: 'late night coding',
      });
      return { ownerUserId, sessionId };
    }

    async function liveTrackTitles(sessionId: string): Promise<unknown> {
      const [row] = await ctx.db
        .select({ snapshot: activitySessions.sessionStyleSnapshot })
        .from(activitySessions)
        .where(eq(activitySessions.id, sessionId));
      return (row!.snapshot as Record<string, unknown>).trackTitles;
    }

    it("grows the session's pool before a submit would run past it", async () => {
      const { sessionId } = await seedPoolSession(['Neon Harbor']);
      const { llm, titleCalls } = titlesLlm(async () => ['Glass Avenue', 'Velvet Static']);

      const result = await runEnsureSessionBuffer(titleDeps(llm), { sessionId });

      expect(result.action).toBe('generate');
      expect(titleCalls).toHaveLength(1);
      expect(titleCalls[0]).toMatchObject({
        takenTitles: ['Neon Harbor'],
        stylePrompt: 'instrumental lofi',
        mood: 'mellow',
        userPrompt: 'late night coding',
      });
      expect(await liveTrackTitles(sessionId)).toEqual([
        'Neon Harbor',
        'Glass Avenue',
        'Velvet Static',
      ]);
    });

    it('makes no title call while the pool still covers the submit', async () => {
      const { sessionId } = await seedPoolSession(['Neon Harbor', 'Glass Avenue']);
      const { llm, titleCalls } = titlesLlm();

      const result = await runEnsureSessionBuffer(titleDeps(llm), { sessionId });

      expect(result.action).toBe('generate');
      expect(titleCalls).toHaveLength(0);
    });

    it('appends only titles the pool lacks, whatever the model returned', async () => {
      const { sessionId } = await seedPoolSession(['Neon Harbor']);
      const { llm } = titlesLlm(async () => ['neon harbor', 'Glass Avenue', 'Glass Avenue']);

      await runEnsureSessionBuffer(titleDeps(llm), { sessionId });

      expect(await liveTrackTitles(sessionId)).toEqual(['Neon Harbor', 'Glass Avenue']);
    });

    it('still submits, with the pool unchanged, when the refill yields nothing or fails', async () => {
      const replies = [async () => [], async () => Promise.reject(new Error('llm down'))];
      for (const reply of replies) {
        const { sessionId } = await seedPoolSession(['Neon Harbor']);
        const result = await runEnsureSessionBuffer(titleDeps(titlesLlm(reply).llm), {
          sessionId,
        });

        expect(result.action).toBe('generate');
        expect(result.submittedTaskId).toBeDefined();
        expect(await liveTrackTitles(sessionId)).toEqual(['Neon Harbor']);
      }
    });

    it('logs a failed refill without the error message, which can carry the prompt', async () => {
      const { sessionId } = await seedPoolSession(['Neon Harbor']);
      const { llm } = titlesLlm(async () =>
        Promise.reject(new Error('Failed query: update … params: late night coding')),
      );
      const logged: unknown[] = [];

      await runEnsureSessionBuffer(
        { ...titleDeps(llm), warn: (message, fields) => logged.push(message, fields) },
        { sessionId },
      );

      expect(logged.length).toBeGreaterThan(0);
      expect(JSON.stringify(logged)).not.toContain('late night coding');
    });

    it("gates a reroll's refill on the session's live pool, not the disliked request's frozen one", async () => {
      const live = ['Neon Harbor', 'Glass Avenue', 'Velvet Static', 'Late Signal'];
      const { ownerUserId, sessionId } = await seedPoolSession(live);
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
        stylePrompt: 'instrumental lofi',
        styleRevision: 1,
        styleSnapshot: { ...POOL_SNAPSHOT, trackTitles: ['Neon Harbor'] },
      });
      const jobId = await createProviderJob(ctx.db, {
        generationRequestId: requestId,
        submitState: 'submitted',
        normalizedStatus: 'ready',
        createdAt: NOW,
      });
      await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
        status: 'rejected',
        dislikedAt: NOW,
        rerollPendingAt: NOW,
      });
      const { llm, titleCalls } = titlesLlm();

      const result = await runEnsureSessionBuffer(titleDeps(llm), { sessionId });

      expect(result.action).toBe('generate');
      expect(titleCalls).toHaveLength(0);
    });
  });
});
