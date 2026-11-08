import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import {
  createQueueSlotAtRevision,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
} from './test-fixtures';
import { activitySessions, activitySessionQueueItems, feedbackEvents } from '../schema';
import { reportPlaybackState } from './session-command-repo';
import { performVibeSwitchCutover } from './vibe-switch-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('vibe-switch cutover (switch-now Change Vibe)', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-vibe-switch-repo-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  interface SeedItemOptions {
    styleRevision: number | null;
    state?: 'queued' | 'playing' | 'played';
    playable?: boolean;
  }

  async function seedItem(
    base: { ownerUserId: string; sessionId: string },
    position: number,
    opts: SeedItemOptions,
  ): Promise<{ trackId: string; queueItemId: string }> {
    return createQueueSlotAtRevision(ctx.db, {
      ownerUserId: base.ownerUserId,
      activitySessionId: base.sessionId,
      position,
      ...opts,
    });
  }

  async function seedArmedSession(
    switchRevision: number,
  ): Promise<{ ownerUserId: string; sessionId: string }> {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    await ctx.db
      .update(activitySessions)
      .set({ styleRevision: switchRevision, vibeSwitchRevision: switchRevision })
      .where(eq(activitySessions.id, sessionId));
    return { ownerUserId, sessionId };
  }

  async function itemStates(
    sessionId: string,
  ): Promise<Array<{ position: number; state: string; vibeSwitchSetAside: boolean }>> {
    const rows = await ctx.db
      .select({
        position: activitySessionQueueItems.position,
        state: activitySessionQueueItems.state,
        vibeSwitchSetAside: activitySessionQueueItems.vibeSwitchSetAside,
      })
      .from(activitySessionQueueItems)
      .where(eq(activitySessionQueueItems.activitySessionId, sessionId));
    return rows.sort((a, b) => a.position - b.position);
  }

  async function switchRevision(sessionId: string): Promise<number | null> {
    const [row] = await ctx.db
      .select({ value: activitySessions.vibeSwitchRevision })
      .from(activitySessions)
      .where(eq(activitySessions.id, sessionId));
    return row?.value ?? null;
  }

  it('marks exactly the older-revision queued items skipped, clears the switch, writes no feedback', async () => {
    const base = await seedArmedSession(2);
    await seedItem(base, 0, { styleRevision: 1, state: 'playing' }); // untouched: playing
    await seedItem(base, 1, { styleRevision: 1 }); // skipped: old revision
    await seedItem(base, 2, { styleRevision: null }); // skipped: legacy/no revision
    await seedItem(base, 3, { styleRevision: 2 }); // the playable new-vibe track

    const result = await performVibeSwitchCutover(ctx.db, base.sessionId);
    expect(result).toEqual({ cutOver: true });

    expect(await itemStates(base.sessionId)).toEqual([
      { position: 0, state: 'playing', vibeSwitchSetAside: false },
      { position: 1, state: 'skipped', vibeSwitchSetAside: true },
      { position: 2, state: 'skipped', vibeSwitchSetAside: true },
      { position: 3, state: 'queued', vibeSwitchSetAside: false },
    ]);
    expect(await switchRevision(base.sessionId)).toBeNull();
    // Setting old-vibe tracks aside is not a listener signal — no feedback rows.
    const feedback = await ctx.db.select().from(feedbackEvents);
    expect(feedback).toHaveLength(0);
  });

  it('does nothing while no new-revision track is playable (switch stays armed)', async () => {
    const base = await seedArmedSession(2);
    await seedItem(base, 0, { styleRevision: 1 });
    await seedItem(base, 1, { styleRevision: 2, playable: false });

    const result = await performVibeSwitchCutover(ctx.db, base.sessionId);
    expect(result).toEqual({ cutOver: false });
    expect(await itemStates(base.sessionId)).toEqual([
      { position: 0, state: 'queued', vibeSwitchSetAside: false },
      { position: 1, state: 'queued', vibeSwitchSetAside: false },
    ]);
    expect(await switchRevision(base.sessionId)).toBe(2);
  });

  it('a started past the set-asides returns them to plain skipped history (flag cleared)', async () => {
    const base = await seedArmedSession(2);
    await seedItem(base, 0, { styleRevision: 1, state: 'playing' }); // audible while the switch armed
    await seedItem(base, 1, { styleRevision: 1 });
    await seedItem(base, 2, { styleRevision: 1 });
    const { queueItemId: newVibeItemId } = await seedItem(base, 3, { styleRevision: 2 });
    await seedItem(base, 4, { styleRevision: 1 }); // beyond the started position
    await performVibeSwitchCutover(ctx.db, base.sessionId);
    expect(await itemStates(base.sessionId)).toEqual([
      { position: 0, state: 'playing', vibeSwitchSetAside: false },
      { position: 1, state: 'skipped', vibeSwitchSetAside: true },
      { position: 2, state: 'skipped', vibeSwitchSetAside: true },
      { position: 3, state: 'queued', vibeSwitchSetAside: false },
      { position: 4, state: 'skipped', vibeSwitchSetAside: true },
    ]);

    // Strictly earlier positions only: a set-aside beyond the started item is
    // still awaiting its walk-past and must stay flagged.
    const result = await reportPlaybackState(ctx.db, {
      ownerUserId: base.ownerUserId,
      sessionId: base.sessionId,
      clientId: 'device-1',
      clientEventId: '60000000-0000-0000-0000-000000000001',
      type: 'started',
      trackId: null,
      queueItemId: newVibeItemId,
      positionSeconds: 0,
      clientTimestamp: new Date('2026-08-01T10:00:00Z'),
    });
    expect(result.ok).toBe(true);

    expect(await itemStates(base.sessionId)).toEqual([
      { position: 0, state: 'played', vibeSwitchSetAside: false },
      { position: 1, state: 'skipped', vibeSwitchSetAside: false },
      { position: 2, state: 'skipped', vibeSwitchSetAside: false },
      { position: 3, state: 'playing', vibeSwitchSetAside: false },
      { position: 4, state: 'skipped', vibeSwitchSetAside: true },
    ]);
  });

  it('an ended report leaves set-asides flagged (only a started spends the switch)', async () => {
    const base = await seedArmedSession(2);
    await seedItem(base, 0, { styleRevision: 1 });
    const { queueItemId: newVibeItemId } = await seedItem(base, 1, { styleRevision: 2 });
    await performVibeSwitchCutover(ctx.db, base.sessionId);

    // `ended` with a lost `started` completes the item itself, but earlier-position
    // sweeps — including the flag clear — belong to `started` alone, so a late or
    // out-of-order `ended` can never disturb navigation state.
    const result = await reportPlaybackState(ctx.db, {
      ownerUserId: base.ownerUserId,
      sessionId: base.sessionId,
      clientId: 'device-1',
      clientEventId: '60000000-0000-0000-0000-000000000002',
      type: 'ended',
      trackId: null,
      queueItemId: newVibeItemId,
      positionSeconds: 180,
      clientTimestamp: new Date('2026-08-01T10:03:00Z'),
    });
    expect(result.ok).toBe(true);

    expect(await itemStates(base.sessionId)).toEqual([
      { position: 0, state: 'skipped', vibeSwitchSetAside: true },
      { position: 1, state: 'played', vibeSwitchSetAside: false },
    ]);
  });

  it('a track-only started (no queue item reference) still clears passed set-asides', async () => {
    const base = await seedArmedSession(2);
    await seedItem(base, 0, { styleRevision: 1 });
    const { trackId: newVibeTrackId } = await seedItem(base, 1, { styleRevision: 2 });
    await performVibeSwitchCutover(ctx.db, base.sessionId);

    const result = await reportPlaybackState(ctx.db, {
      ownerUserId: base.ownerUserId,
      sessionId: base.sessionId,
      clientId: 'device-1',
      clientEventId: '60000000-0000-0000-0000-000000000003',
      type: 'started',
      trackId: newVibeTrackId,
      queueItemId: null,
      positionSeconds: 0,
      clientTimestamp: new Date('2026-08-01T10:00:00Z'),
    });
    expect(result.ok).toBe(true);

    expect(await itemStates(base.sessionId)).toEqual([
      { position: 0, state: 'skipped', vibeSwitchSetAside: false },
      { position: 1, state: 'playing', vibeSwitchSetAside: false },
    ]);
  });

  it('a wrapped started (Queue loop restart) clears even trailing set-asides', async () => {
    const base = await seedArmedSession(2);
    const { queueItemId: firstItemId } = await seedItem(base, 0, {
      styleRevision: 1,
      state: 'played',
    });
    const { queueItemId: newVibeItemId } = await seedItem(base, 1, { styleRevision: 2 });
    await seedItem(base, 2, { styleRevision: 1 }); // trailing: no slot above it ever starts
    await performVibeSwitchCutover(ctx.db, base.sessionId);

    const started = await reportPlaybackState(ctx.db, {
      ownerUserId: base.ownerUserId,
      sessionId: base.sessionId,
      clientId: 'device-1',
      clientEventId: '60000000-0000-0000-0000-000000000004',
      type: 'started',
      trackId: null,
      queueItemId: newVibeItemId,
      positionSeconds: 0,
      clientTimestamp: new Date('2026-08-01T10:00:00Z'),
    });
    expect(started.ok).toBe(true);
    // The strictly-earlier sweep can never reach a set-aside above the highest
    // slot that ever starts — that is exactly what the wrap signal is for.
    expect(await itemStates(base.sessionId)).toEqual([
      { position: 0, state: 'played', vibeSwitchSetAside: false },
      { position: 1, state: 'playing', vibeSwitchSetAside: false },
      { position: 2, state: 'skipped', vibeSwitchSetAside: true },
    ]);

    const wrapped = await reportPlaybackState(ctx.db, {
      ownerUserId: base.ownerUserId,
      sessionId: base.sessionId,
      clientId: 'device-1',
      clientEventId: '60000000-0000-0000-0000-000000000005',
      type: 'started',
      trackId: null,
      queueItemId: firstItemId,
      positionSeconds: 0,
      clientTimestamp: new Date('2026-08-01T10:04:00Z'),
      queueWrapped: true,
    });
    expect(wrapped.ok).toBe(true);
    const states = await itemStates(base.sessionId);
    expect(states.map((s) => s.vibeSwitchSetAside)).toEqual([false, false, false]);
  });

  it('is a no-op without an armed switch, and idempotent after a cutover', async () => {
    const base = await seedArmedSession(2);
    await seedItem(base, 0, { styleRevision: 1 });
    await seedItem(base, 1, { styleRevision: 2 });

    expect(await performVibeSwitchCutover(ctx.db, base.sessionId)).toEqual({ cutOver: true });
    // A late-materializing old-vibe pair lands AFTER the cutover cleared the
    // switch — it stays queued (documented rule: cutover is a one-shot pass).
    await seedItem(base, 2, { styleRevision: 1 });
    expect(await performVibeSwitchCutover(ctx.db, base.sessionId)).toEqual({ cutOver: false });
    expect(await itemStates(base.sessionId)).toEqual([
      { position: 0, state: 'skipped', vibeSwitchSetAside: true },
      { position: 1, state: 'queued', vibeSwitchSetAside: false },
      { position: 2, state: 'queued', vibeSwitchSetAside: false },
    ]);
  });
});
