import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { deletionQueueItems, trackAudioAssets } from '../schema';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { withTransaction } from '../transactions';
import { GENERATION_FIXTURE_TABLES, createUser, seedReadyTrack } from './test-fixtures';
import {
  listDueDeletionQueueItems,
  markDeletionQueueItemProcessed,
  queueTrackAudioDeletion,
  recordDeletionQueueItemFailure,
} from './deletion-queue-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const NOW = new Date('2026-07-01T12:00:00Z');

describeIfDb('deletion-queue repo', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-deletion-queue-repo-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  async function queueItem(fx: {
    ownerUserId: string;
    storageKey?: string | null;
    deleteAfter: Date;
    processedAt?: Date;
  }): Promise<string> {
    const [row] = await ctx.db
      .insert(deletionQueueItems)
      .values({
        ownerUserId: fx.ownerUserId,
        storageKey: fx.storageKey === undefined ? 'a/file.mp3' : fx.storageKey,
        reason: 'test',
        deleteAfter: fx.deleteAfter,
        processedAt: fx.processedAt ?? null,
      })
      .returning({ id: deletionQueueItems.id });
    return row!.id;
  }

  it('lists only unprocessed items whose deleteAfter has passed, oldest due first', async () => {
    const ownerUserId = await createUser(ctx.db);
    const dueOld = await queueItem({
      ownerUserId,
      storageKey: 'a/due-old.mp3',
      deleteAfter: new Date('2026-07-01T10:00:00Z'),
    });
    const dueNew = await queueItem({
      ownerUserId,
      storageKey: 'a/due-new.mp3',
      deleteAfter: new Date('2026-07-01T11:00:00Z'),
    });
    // Not yet due (the Reject ~24h grace) and already processed → both excluded.
    await queueItem({ ownerUserId, deleteAfter: new Date('2026-07-02T10:00:00Z') });
    await queueItem({
      ownerUserId,
      deleteAfter: new Date('2026-07-01T09:00:00Z'),
      processedAt: new Date('2026-07-01T09:05:00Z'),
    });

    const due = await listDueDeletionQueueItems(ctx.db, { now: NOW, limit: 10 });
    expect(due.map((item) => item.id)).toEqual([dueOld, dueNew]);
    expect(due.every((item) => !item.storageKeyLive)).toBe(true);
  });

  it('respects the batch limit', async () => {
    const ownerUserId = await createUser(ctx.db);
    await queueItem({ ownerUserId, deleteAfter: new Date('2026-07-01T10:00:00Z') });
    await queueItem({ ownerUserId, deleteAfter: new Date('2026-07-01T11:00:00Z') });
    expect(await listDueDeletionQueueItems(ctx.db, { now: NOW, limit: 1 })).toHaveLength(1);
  });

  it('flags a storage key that a live audio asset references again', async () => {
    // Stage a track whose audio re-landed at the same canonical key after the
    // deletion was queued (re-Save re-download) — the file must not be deleted.
    const seeded = await seedReadyTrack(ctx.db);
    const [asset] = await ctx.db
      .select({ storageKey: trackAudioAssets.storageKey })
      .from(trackAudioAssets)
      .where(eq(trackAudioAssets.trackId, seeded.trackId));
    await queueItem({
      ownerUserId: seeded.ownerUserId,
      storageKey: asset!.storageKey,
      deleteAfter: new Date('2026-07-01T10:00:00Z'),
    });

    const due = await listDueDeletionQueueItems(ctx.db, { now: NOW, limit: 10 });
    expect(due).toHaveLength(1);
    expect(due[0]!.storageKeyLive).toBe(true);
  });

  it('does not flag a dead storage key just because unrelated live assets exist', async () => {
    // Regression: the live-key `exists` must correlate on the ITEM's key. It once
    // rendered as `"storage_key" = "storage_key"` (a tautology), which reported
    // every key as live whenever ANY audio asset existed — so no file was ever
    // deleted. A dead key must stay dead while another track's audio is live.
    const seeded = await seedReadyTrack(ctx.db);
    await queueItem({
      ownerUserId: seeded.ownerUserId,
      storageKey: 'a/evicted-and-gone.mp3',
      deleteAfter: new Date('2026-07-01T10:00:00Z'),
    });

    const due = await listDueDeletionQueueItems(ctx.db, { now: NOW, limit: 10 });
    expect(due).toHaveLength(1);
    expect(due[0]!.storageKeyLive).toBe(false);
  });

  it('markDeletionQueueItemProcessed resolves the item and clears a stale failure note', async () => {
    const ownerUserId = await createUser(ctx.db);
    const id = await queueItem({ ownerUserId, deleteAfter: new Date('2026-07-01T10:00:00Z') });
    expect(
      await recordDeletionQueueItemFailure(ctx.db, {
        id,
        errorMessageSafe: 'storage delete failed',
      }),
    ).toBe(true);

    // The failure leaves it due (retried next run), with the error recorded.
    let [row] = await ctx.db.select().from(deletionQueueItems).where(eq(deletionQueueItems.id, id));
    expect(row!.processedAt).toBeNull();
    expect(row!.errorMessageSafe).toBe('storage delete failed');
    expect(await listDueDeletionQueueItems(ctx.db, { now: NOW, limit: 10 })).toHaveLength(1);

    expect(await markDeletionQueueItemProcessed(ctx.db, { id, now: NOW })).toBe(true);
    [row] = await ctx.db.select().from(deletionQueueItems).where(eq(deletionQueueItems.id, id));
    expect(row!.processedAt).toEqual(NOW);
    expect(row!.errorMessageSafe).toBeNull();
    expect(await listDueDeletionQueueItems(ctx.db, { now: NOW, limit: 10 })).toHaveLength(0);
  });

  it('never re-resolves or re-stamps an item another run already settled (conditional writes)', async () => {
    const ownerUserId = await createUser(ctx.db);
    const id = await queueItem({ ownerUserId, deleteAfter: new Date('2026-07-01T10:00:00Z') });
    expect(await markDeletionQueueItemProcessed(ctx.db, { id, now: NOW })).toBe(true);

    // A straggling overlapping run: neither write may touch the settled row.
    const later = new Date('2026-07-01T13:00:00Z');
    expect(await markDeletionQueueItemProcessed(ctx.db, { id, now: later, noteSafe: 'x' })).toBe(
      false,
    );
    expect(await recordDeletionQueueItemFailure(ctx.db, { id, errorMessageSafe: 'y' })).toBe(false);

    const [row] = await ctx.db
      .select()
      .from(deletionQueueItems)
      .where(eq(deletionQueueItems.id, id));
    expect(row!.processedAt).toEqual(NOW); // first resolution wins
    expect(row!.errorMessageSafe).toBeNull();
  });

  it('queueTrackAudioDeletion snapshots the current asset keys and drops the rows in one transaction', async () => {
    const seeded = await seedReadyTrack(ctx.db);
    const [asset] = await ctx.db
      .select({ storageKey: trackAudioAssets.storageKey })
      .from(trackAudioAssets)
      .where(eq(trackAudioAssets.trackId, seeded.trackId));

    await withTransaction(ctx.db, (tx) =>
      queueTrackAudioDeletion(tx, {
        trackId: seeded.trackId,
        ownerUserId: seeded.ownerUserId,
        reason: 'test',
        deleteAfter: NOW,
      }),
    );

    const queued = await ctx.db
      .select()
      .from(deletionQueueItems)
      .where(eq(deletionQueueItems.trackId, seeded.trackId));
    expect(queued.map((item) => item.storageKey)).toEqual([asset!.storageKey]);
    expect(queued[0]!.deleteAfter).toEqual(NOW);
    const remaining = await ctx.db
      .select()
      .from(trackAudioAssets)
      .where(eq(trackAudioAssets.trackId, seeded.trackId));
    expect(remaining).toEqual([]); // asset rows dropped with their keys queued
  });
});
