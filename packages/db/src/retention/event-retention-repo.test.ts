import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import {
  createGenerationRequest,
  createProviderJob,
  createSession,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
} from '../generation/test-fixtures';
import { countTasksInWindow } from '../generation/limits-repo';
import { ownerScope } from '../member-pool';
import { feedbackEvents, playbackEvents, usageEvents } from '../schema';
import {
  PLAYBACK_EVENT_RETENTION_DAYS,
  pruneEventTables,
  USAGE_EVENT_RETENTION_DAYS,
} from './event-retention-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const NOW = new Date('2026-08-04T12:00:00Z');
const daysBefore = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
const LONG_AGO = daysBefore(PLAYBACK_EVENT_RETENTION_DAYS + 30);
const RECENT = daysBefore(1);

describeIfDb('append-only event-table retention', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-event-retention-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, [...GENERATION_FIXTURE_TABLES, 'usage_events']);
  });

  async function seedOwnerWithTrack(): Promise<{
    ownerUserId: string;
    sessionId: string;
    trackId: string;
  }> {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const generationRequestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const providerJobId = await createProviderJob(ctx.db, { generationRequestId });
    const trackId = await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId,
      providerJobId,
    });
    return { ownerUserId, sessionId, trackId };
  }

  async function addPlaybackEvent(fx: {
    ownerUserId: string;
    sessionId: string;
    trackId: string | null;
    eventType: 'started' | 'ended';
    createdAt: Date;
    clientEventId: string;
  }): Promise<void> {
    await ctx.db.insert(playbackEvents).values({
      ownerUserId: fx.ownerUserId,
      activitySessionId: fx.sessionId,
      trackId: fx.trackId,
      eventType: fx.eventType,
      clientEventId: fx.clientEventId,
      clientTimestamp: fx.createdAt,
      createdAt: fx.createdAt,
    });
  }

  async function survivingEventIds(): Promise<string[]> {
    const rows = await ctx.db
      .select({ clientEventId: playbackEvents.clientEventId })
      .from(playbackEvents);
    return rows.map((row) => row.clientEventId!).sort();
  }

  // The two app readers of `playback_events` — the Library's `hasPlayed` column
  // and the Dislike reroll's unplayed-sibling probe — both reduce to "a `started`
  // row exists for this track". Pruning one of those away would silently flip a
  // played track back to unplayed in the Library and re-offer it as an unplayed
  // reroll sibling, so age alone must never decide their fate.
  it('keeps a live track’s started event past the horizon and prunes what nothing reads', async () => {
    const { ownerUserId, sessionId, trackId } = await seedOwnerWithTrack();
    await addPlaybackEvent({
      ownerUserId,
      sessionId,
      trackId,
      eventType: 'started',
      createdAt: LONG_AGO,
      clientEventId: 'old-started-live-track',
    });
    // The track was deleted (`ON DELETE SET NULL`), so no reader can reach this.
    await addPlaybackEvent({
      ownerUserId,
      sessionId,
      trackId: null,
      eventType: 'started',
      createdAt: LONG_AGO,
      clientEventId: 'old-started-deleted-track',
    });
    await addPlaybackEvent({
      ownerUserId,
      sessionId,
      trackId,
      eventType: 'ended',
      createdAt: LONG_AGO,
      clientEventId: 'old-ended',
    });
    await addPlaybackEvent({
      ownerUserId,
      sessionId,
      trackId,
      eventType: 'ended',
      createdAt: RECENT,
      clientEventId: 'recent-ended',
    });
    // `feedback_events` is kept forever — no horizon touches it.
    await ctx.db.insert(feedbackEvents).values({
      userId: ownerUserId,
      trackId,
      activitySessionId: sessionId,
      feedbackType: 'skip',
      createdAt: LONG_AGO,
    });

    const result = await pruneEventTables(ctx.db, { now: NOW });

    expect(result.playbackEventsDeleted).toBe(2);
    expect(await survivingEventIds()).toEqual(['old-started-live-track', 'recent-ended']);
    expect(await ctx.db.select().from(feedbackEvents)).toHaveLength(1);
  });

  // Cost controls count `provider_jobs`, never this ledger. If that ever changes,
  // pruning would silently under-count spend and let a member generate past their
  // cap — so the independence is asserted, not assumed.
  it('leaves the daily/monthly spend windows computable after pruning the ledger', async () => {
    const { ownerUserId } = await seedOwnerWithTrack();
    const veryOld = daysBefore(USAGE_EVENT_RETENTION_DAYS + 30);
    await ctx.db.insert(usageEvents).values([
      {
        userId: ownerUserId,
        providerType: 'music',
        providerKey: 'mock',
        operation: 'generate',
        units: 1,
        createdAt: veryOld,
      },
      {
        userId: ownerUserId,
        providerType: 'music',
        providerKey: 'mock',
        operation: 'generate',
        units: 1,
        createdAt: RECENT,
      },
    ]);
    const scope = ownerScope(ownerUserId);
    const before = await countTasksInWindow(ctx.db, { scope, since: new Date(0) });
    expect(before).toBe(1);

    const result = await pruneEventTables(ctx.db, { now: NOW });

    expect(result.usageEventsDeleted).toBe(1);
    expect(await ctx.db.select().from(usageEvents)).toHaveLength(1);
    expect(await countTasksInWindow(ctx.db, { scope, since: new Date(0) })).toBe(before);
  });

  // A single unbounded DELETE over years of playback rows would lock the table
  // the live playback route writes to; the run budget is what stops that.
  it('deletes no more than batchSize × maxBatches rows in one run', async () => {
    const { ownerUserId, sessionId, trackId } = await seedOwnerWithTrack();
    for (let i = 0; i < 5; i += 1) {
      await addPlaybackEvent({
        ownerUserId,
        sessionId,
        trackId,
        eventType: 'ended',
        createdAt: LONG_AGO,
        clientEventId: `old-${i}`,
      });
    }

    const first = await pruneEventTables(ctx.db, { now: NOW, batchSize: 2, maxBatches: 1 });
    expect(first.playbackEventsDeleted).toBe(2);
    expect(await ctx.db.select().from(playbackEvents)).toHaveLength(3);

    // The next run drains the rest — a backlog costs runs, never one long lock.
    const second = await pruneEventTables(ctx.db, { now: NOW, batchSize: 2, maxBatches: 25 });
    expect(second.playbackEventsDeleted).toBe(3);
    expect(
      await ctx.db.select().from(playbackEvents).where(eq(playbackEvents.trackId, trackId)),
    ).toHaveLength(0);
  });
});
