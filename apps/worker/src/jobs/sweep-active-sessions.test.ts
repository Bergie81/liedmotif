import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { activitySessions, updateUsageLimits } from '@liedmotif/db';
import {
  connectTestDb,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { runSweepActiveSessions } from './sweep-active-sessions';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('sweep-active-sessions job', () => {
  let ctx: TestDb;
  const NOW = new Date('2026-06-29T12:00:00Z');
  const minutesAgo = (m: number): Date => new Date(NOW.getTime() - m * 60_000);

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-sweep-job-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, [...GENERATION_FIXTURE_TABLES, 'app_settings']);
  });

  async function statusEndReason(
    sessionId: string,
  ): Promise<{ status: string; endReason: string | null }> {
    const [row] = await ctx.db
      .select({ status: activitySessions.status, endReason: activitySessions.endReason })
      .from(activitySessions)
      .where(eq(activitySessions.id, sessionId));
    return { status: row!.status, endReason: row!.endReason };
  }

  it('idle sessions stop; a duration target never ends an active listener', async () => {
    // One active session per owner (the one-active-per-owner invariant).
    const idleOwner = await createUser(ctx.db);
    const idle = await createSession(ctx.db, {
      ownerUserId: idleOwner,
      startedAt: minutesAgo(40),
      lastPlaybackReportAt: minutesAgo(30),
      idleAutoStopAfterMinutes: 15,
    });

    const boundedOwner = await createUser(ctx.db);
    const bounded = await createSession(ctx.db, {
      ownerUserId: boundedOwner,
      startedAt: minutesAgo(60),
      lastPlaybackReportAt: minutesAgo(1),
      targetDurationMinutes: 45,
    });

    const healthyOwner = await createUser(ctx.db);
    const healthy = await createSession(ctx.db, {
      ownerUserId: healthyOwner,
      startedAt: minutesAgo(10),
      lastPlaybackReportAt: minutesAgo(1),
      targetDurationMinutes: null,
    });

    const buffered: string[] = [];
    const result = await runSweepActiveSessions({
      db: ctx.db,
      now: NOW,
      enqueueBuffer: async (sessionId) => {
        buffered.push(sessionId);
      },
    });

    expect(await statusEndReason(idle)).toEqual({ status: 'stopped', endReason: 'idle_timeout' });
    expect(await statusEndReason(bounded)).toEqual({
      status: 'active',
      endReason: null,
    });
    expect(await statusEndReason(healthy)).toEqual({ status: 'active', endReason: null });

    expect(buffered).toEqual(expect.arrayContaining([bounded, healthy]));
    expect(buffered).toHaveLength(2);
    expect(result.stopped.map((s) => s.endReason)).toEqual(['idle_timeout']);
    expect(result.buffered).toEqual(buffered);
  });

  // Settings → Limits is the one place the idle window is set; a Session must
  // not keep an older figure of its own.
  it('stops idle Sessions on the instance idle auto-stop setting', async () => {
    await updateUsageLimits(ctx.db, { idleAutoStopAfterMinutes: 120 });

    const pausedOwner = await createUser(ctx.db);
    const paused = await createSession(ctx.db, {
      ownerUserId: pausedOwner,
      startedAt: minutesAgo(60),
      lastPlaybackReportAt: minutesAgo(30),
    });
    const abandonedOwner = await createUser(ctx.db);
    const abandoned = await createSession(ctx.db, {
      ownerUserId: abandonedOwner,
      startedAt: minutesAgo(200),
      lastPlaybackReportAt: minutesAgo(130),
    });

    await runSweepActiveSessions({ db: ctx.db, now: NOW, enqueueBuffer: async () => {} });

    expect(await statusEndReason(paused)).toEqual({ status: 'active', endReason: null });
    expect(await statusEndReason(abandoned)).toEqual({
      status: 'stopped',
      endReason: 'idle_timeout',
    });
  });
});
