import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { activitySessions } from '../schema';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import {
  createGenerationRequest,
  createProviderJob,
  createQueueSlotAtRevision,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
} from './test-fixtures';
import {
  countInFlightSessionJobs,
  countReadyAheadTracks,
  countSessionGenerationRequests,
  countSessionOwnReadyTracks,
  getBufferSessionCounts,
  getEarliestReadySessionMusicTaskId,
  getRecentLyricBriefs,
  listActiveSessionsForSweep,
  stopSessionFromWorker,
} from './sessions-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('sessions repo — sweep + stop', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-sessions-repo-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  it('lists only active sessions for the sweep (Stopped excluded)', async () => {
    const ownerA = await createUser(ctx.db);
    const activeId = await createSession(ctx.db, { ownerUserId: ownerA });
    await createSession(ctx.db, { ownerUserId: ownerA, status: 'stopped' });

    const swept = await listActiveSessionsForSweep(ctx.db);
    expect(swept.map((s) => s.sessionId)).toEqual([activeId]);
  });

  it('bounds one sweep pass, stalest playback first, so auto-stops are never starved by the cap', async () => {
    const staleOwner = await createUser(ctx.db);
    const stale = await createSession(ctx.db, {
      ownerUserId: staleOwner,
      lastPlaybackReportAt: new Date('2026-06-29T10:00:00Z'),
    });
    const freshOwner = await createUser(ctx.db);
    await createSession(ctx.db, {
      ownerUserId: freshOwner,
      lastPlaybackReportAt: new Date('2026-06-29T11:59:00Z'),
    });

    const swept = await listActiveSessionsForSweep(ctx.db, { limit: 1 });
    expect(swept.map((s) => s.sessionId)).toEqual([stale]);
  });

  it('stops an active session: status=stopped, endReason + stoppedAt set', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    await ctx.db
      .update(activitySessions)
      .set({ vibeSwitchRevision: 2 })
      .where(eq(activitySessions.id, sessionId));
    const now = new Date('2026-06-29T12:00:00Z');

    const result = await stopSessionFromWorker(ctx.db, {
      sessionId,
      endReason: 'idle_timeout',
      now,
    });
    expect(result.stopped).toBe(true);

    const [row] = await ctx.db
      .select()
      .from(activitySessions)
      .where(eq(activitySessions.id, sessionId));
    expect(row!.status).toBe('stopped');
    expect(row!.endReason).toBe('idle_timeout');
    expect(row!.stoppedAt?.toISOString()).toBe(now.toISOString());
    expect(row!.vibeSwitchRevision).toBeNull();
  });

  it('is a no-op for an already-stopped session (transition guard)', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      status: 'stopped',
    });

    const result = await stopSessionFromWorker(ctx.db, {
      sessionId,
      endReason: 'completed_duration',
      now: new Date(),
    });
    expect(result.stopped).toBe(false);

    const [row] = await ctx.db
      .select()
      .from(activitySessions)
      .where(eq(activitySessions.id, sessionId));
    // endReason stays null — the worker never overwrote the prior stop.
    expect(row!.endReason).toBeNull();
  });
});

describeIfDb('sessions repo — earliest ready music task (Suno cover fallback)', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-sessions-repo-ready-task-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  async function seed() {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    return { ownerUserId, sessionId };
  }

  it('returns null while the session has no ready job for the provider', async () => {
    const { ownerUserId, sessionId } = await seed();
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      providerKey: 'suno',
    });
    await createProviderJob(ctx.db, {
      generationRequestId: requestId,
      providerKey: 'suno',
      normalizedStatus: 'processing',
    });

    await expect(
      getEarliestReadySessionMusicTaskId(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
        providerKey: 'suno',
      }),
    ).resolves.toBeNull();
  });

  it('returns the earliest ready task id, ignoring other providers and null task ids', async () => {
    const { ownerUserId, sessionId } = await seed();
    const early = new Date('2026-07-01T10:00:00Z');
    const late = new Date('2026-07-01T11:00:00Z');

    const otherProviderRequest = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      providerKey: 'mock',
    });
    await createProviderJob(ctx.db, {
      generationRequestId: otherProviderRequest,
      providerKey: 'mock',
      normalizedStatus: 'ready',
      createdAt: new Date('2026-07-01T09:00:00Z'),
    });

    const taskLessRequest = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      providerKey: 'suno',
    });
    await createProviderJob(ctx.db, {
      generationRequestId: taskLessRequest,
      providerKey: 'suno',
      normalizedStatus: 'ready',
      providerTaskId: null,
      createdAt: new Date('2026-07-01T09:30:00Z'),
    });

    const earlyRequest = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      providerKey: 'suno',
    });
    await createProviderJob(ctx.db, {
      generationRequestId: earlyRequest,
      providerKey: 'suno',
      normalizedStatus: 'ready',
      providerTaskId: 'task-early',
      createdAt: early,
    });

    const lateRequest = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      providerKey: 'suno',
    });
    await createProviderJob(ctx.db, {
      generationRequestId: lateRequest,
      providerKey: 'suno',
      normalizedStatus: 'ready',
      providerTaskId: 'task-late',
      createdAt: late,
    });

    await expect(
      getEarliestReadySessionMusicTaskId(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
        providerKey: 'suno',
      }),
    ).resolves.toBe('task-early');
  });

  it('scopes to the owner and the session', async () => {
    const { ownerUserId, sessionId } = await seed();
    const otherOwner = await createUser(ctx.db);
    const otherSession = await createSession(ctx.db, { ownerUserId: otherOwner });
    const otherRequest = await createGenerationRequest(ctx.db, {
      ownerUserId: otherOwner,
      activitySessionId: otherSession,
      providerKey: 'suno',
    });
    await createProviderJob(ctx.db, {
      generationRequestId: otherRequest,
      providerKey: 'suno',
      normalizedStatus: 'ready',
      providerTaskId: 'task-foreign',
    });

    await expect(
      getEarliestReadySessionMusicTaskId(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
        providerKey: 'suno',
      }),
    ).resolves.toBeNull();
  });
});

describeIfDb('recent lyric briefs', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-recent-lyric-briefs-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  /** Briefs A, B, '', C in creation order, plus a newer foreign-session brief. */
  async function seedBriefHistory() {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const briefs = ['A', 'B', '', 'C'] as const;
    const requestIds: string[] = [];
    for (let i = 0; i < briefs.length; i += 1) {
      requestIds.push(
        await createGenerationRequest(ctx.db, {
          ownerUserId,
          activitySessionId: sessionId,
          styleSnapshot: { lyricContext: briefs[i] },
          createdAt: new Date(`2026-08-10T10:0${i}:00Z`),
        }),
      );
    }
    const otherOwner = await createUser(ctx.db);
    const otherSession = await createSession(ctx.db, { ownerUserId: otherOwner });
    await createGenerationRequest(ctx.db, {
      ownerUserId: otherOwner,
      activitySessionId: otherSession,
      styleSnapshot: { lyricContext: 'X' },
      createdAt: new Date('2026-08-10T11:00:00Z'),
    });
    return { sessionId, requestIds };
  }

  it('returns newest-first non-empty briefs and never leaks another session', async () => {
    const { sessionId } = await seedBriefHistory();
    await expect(getRecentLyricBriefs(ctx.db, { sessionId, limit: 6 })).resolves.toEqual([
      'C',
      'B',
      'A',
    ]);
  });

  it('caps at the limit counted over non-empty briefs', async () => {
    const { sessionId } = await seedBriefHistory();
    await expect(getRecentLyricBriefs(ctx.db, { sessionId, limit: 2 })).resolves.toEqual([
      'C',
      'B',
    ]);
  });

  it("excludes the caller's own request so its static notes never spend a memory slot", async () => {
    const { sessionId, requestIds } = await seedBriefHistory();
    await expect(
      getRecentLyricBriefs(ctx.db, { sessionId, limit: 6, excludeRequestId: requestIds[3]! }),
    ).resolves.toEqual(['B', 'A']);
  });
});

describeIfDb('buffer session counts — combined statement', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-buffer-counts-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  async function seedMixedSession() {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    // Ready-ahead supply across revisions, plus a played slot that never counts.
    await createQueueSlotAtRevision(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      styleRevision: 1,
      position: 0,
      state: 'played',
    });
    await createQueueSlotAtRevision(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      styleRevision: 1,
      position: 1,
    });
    await createQueueSlotAtRevision(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      styleRevision: 2,
      position: 2,
    });
    // In-flight jobs: one at each revision, plus a terminal one that is not,
    // and an unbilled refusal at each revision that only `totalRequests` counts.
    for (const [styleRevision, normalizedStatus, submitState] of [
      [1, 'processing', 'submitted'],
      [2, 'processing', 'submitted'],
      [2, 'ready', 'submitted'],
      [1, 'provider_rate_limited', 'submit_rejected'],
      [2, 'blocked_by_provider_credits', 'submit_rejected'],
    ] as const) {
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
        styleRevision,
      });
      await createProviderJob(ctx.db, {
        generationRequestId: requestId,
        normalizedStatus,
        submitState,
      });
    }
    return { ownerUserId, sessionId };
  }

  it('matches the standalone counts (unscoped)', async () => {
    const { sessionId } = await seedMixedSession();
    const phantomSubmitCutoff = new Date(Date.now() - 15 * 60_000);

    const combined = await getBufferSessionCounts(ctx.db, { sessionId, phantomSubmitCutoff });
    expect(combined).toEqual({
      readyAhead: await countReadyAheadTracks(ctx.db, sessionId),
      ownReady: await countSessionOwnReadyTracks(ctx.db, sessionId),
      inFlightJobs: await countInFlightSessionJobs(ctx.db, { sessionId, phantomSubmitCutoff }),
      // Each queue slot's unsettled ready job created 1 of 2 Tracks (3 × 1); the two
      // processing jobs and the ready job with no Tracks owe 2 each (3 × 2).
      incomingTracks: 9,
      totalRequests: await countSessionGenerationRequests(ctx.db, sessionId),
      unrefusedRequests: await countSessionGenerationRequests(ctx.db, sessionId, {
        excludeUnbilledRefusals: true,
      }),
      currentRevisionUnrefusedRequests: await countSessionGenerationRequests(ctx.db, sessionId, {
        excludeUnbilledRefusals: true,
      }),
    });
    // Only the two refused requests drop out.
    expect(combined.totalRequests - combined.unrefusedRequests).toBe(2);
  });

  it('matches the standalone counts under revision scoping', async () => {
    const { sessionId } = await seedMixedSession();
    const phantomSubmitCutoff = new Date(Date.now() - 15 * 60_000);

    const combined = await getBufferSessionCounts(ctx.db, {
      sessionId,
      phantomSubmitCutoff,
      supplyAtOrAboveStyleRevision: 2,
      requestsAtOrAboveStyleRevision: 2,
    });
    expect(combined).toEqual({
      readyAhead: await countReadyAheadTracks(ctx.db, sessionId, { atOrAboveStyleRevision: 2 }),
      ownReady: await countSessionOwnReadyTracks(ctx.db, sessionId),
      inFlightJobs: await countInFlightSessionJobs(ctx.db, {
        sessionId,
        phantomSubmitCutoff,
        atOrAboveStyleRevision: 2,
      }),
      // Revision 2 only: its queue slot's job (1) plus its processing and ready jobs (2 + 2).
      incomingTracks: 5,
      totalRequests: await countSessionGenerationRequests(ctx.db, sessionId),
      unrefusedRequests: await countSessionGenerationRequests(ctx.db, sessionId, {
        excludeUnbilledRefusals: true,
      }),
      currentRevisionUnrefusedRequests: await countSessionGenerationRequests(ctx.db, sessionId, {
        atOrAboveStyleRevision: 2,
        excludeUnbilledRefusals: true,
      }),
    });
    // Only the revision-2 refusal drops out of the revision-2 count.
    expect(
      (await countSessionGenerationRequests(ctx.db, sessionId, { atOrAboveStyleRevision: 2 })) -
        combined.currentRevisionUnrefusedRequests,
    ).toBe(1);
  });

  it('returns zeros for a session with no work', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const combined = await getBufferSessionCounts(ctx.db, {
      sessionId,
      phantomSubmitCutoff: new Date(),
    });
    expect(combined).toEqual({
      readyAhead: 0,
      ownReady: 0,
      inFlightJobs: 0,
      incomingTracks: 0,
      totalRequests: 0,
      unrefusedRequests: 0,
      currentRevisionUnrefusedRequests: 0,
    });
  });
});
