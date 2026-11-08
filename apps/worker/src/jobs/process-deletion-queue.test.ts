import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { deletionQueueItems } from '@liedmotif/db';
import {
  connectTestDb,
  createUser,
  GENERATION_FIXTURE_TABLES,
  seedReadyTrack,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { createMockStorageProvider, type MockStorage } from '@liedmotif/storage';
import { runProcessDeletionQueue } from './process-deletion-queue';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const NOW = new Date('2026-07-01T12:00:00Z');
const PAST = new Date('2026-07-01T10:00:00Z');

describeIfDb('process-deletion-queue job', () => {
  let ctx: TestDb;
  let mock: MockStorage;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-process-deletion-queue-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
    await mock?.cleanup();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
    await mock?.cleanup();
    mock = createMockStorageProvider();
  });

  async function queueItem(fx: {
    ownerUserId: string;
    storageKey: string | null;
    deleteAfter?: Date;
  }): Promise<string> {
    const [row] = await ctx.db
      .insert(deletionQueueItems)
      .values({
        ownerUserId: fx.ownerUserId,
        storageKey: fx.storageKey,
        reason: 'test',
        deleteAfter: fx.deleteAfter ?? PAST,
      })
      .returning({ id: deletionQueueItems.id });
    return row!.id;
  }

  async function itemRow(id: string) {
    const [row] = await ctx.db
      .select()
      .from(deletionQueueItems)
      .where(eq(deletionQueueItems.id, id));
    return row!;
  }

  it('deletes the due file from storage and marks the item processed', async () => {
    const ownerUserId = await createUser(ctx.db);
    const key = 'tracks/owner/track/original.mp3';
    await mock.provider.write({ key, body: Buffer.from('audio-bytes') });
    const id = await queueItem({ ownerUserId, storageKey: key });
    // Not yet due → untouched this run.
    const futureKey = 'tracks/owner/track2/original.mp3';
    await mock.provider.write({ key: futureKey, body: Buffer.from('later') });
    const futureId = await queueItem({
      ownerUserId,
      storageKey: futureKey,
      deleteAfter: new Date('2026-07-02T10:00:00Z'),
    });

    const result = await runProcessDeletionQueue({
      db: ctx.db,
      storage: mock.provider,
      now: NOW,
    });

    expect(result).toEqual({ deleted: 1, skippedLiveKey: 0, failed: 0 });
    expect(await mock.provider.stat(key)).toBeNull(); // bytes actually reclaimed
    expect((await itemRow(id)).processedAt).toEqual(NOW);
    expect(await mock.provider.stat(futureKey)).not.toBeNull();
    expect((await itemRow(futureId)).processedAt).toBeNull();
  });

  it('is idempotent when the file is already gone (crash between delete and mark)', async () => {
    const ownerUserId = await createUser(ctx.db);
    const id = await queueItem({ ownerUserId, storageKey: 'tracks/owner/gone/original.mp3' });

    const result = await runProcessDeletionQueue({ db: ctx.db, storage: mock.provider, now: NOW });

    expect(result).toEqual({ deleted: 1, skippedLiveKey: 0, failed: 0 });
    expect((await itemRow(id)).processedAt).toEqual(NOW);
  });

  it('never deletes a key that a live audio asset references again; resolves the item', async () => {
    const seeded = await seedReadyTrack(ctx.db);
    const [asset] = await ctx.pool
      .query<{ storage_key: string }>(
        'select storage_key from track_audio_assets where track_id = $1',
        [seeded.trackId],
      )
      .then((res) => res.rows);
    await mock.provider.write({ key: asset!.storage_key, body: Buffer.from('re-landed') });
    const id = await queueItem({ ownerUserId: seeded.ownerUserId, storageKey: asset!.storage_key });

    const result = await runProcessDeletionQueue({ db: ctx.db, storage: mock.provider, now: NOW });

    expect(result).toEqual({ deleted: 0, skippedLiveKey: 1, failed: 0 });
    expect(await mock.provider.stat(asset!.storage_key)).not.toBeNull(); // file survives
    const row = await itemRow(id);
    expect(row.processedAt).toEqual(NOW); // obsolete item resolved, not retried
    expect(row.errorMessageSafe).toContain('live audio asset');
  });

  it('resolves a keyless item (nothing to delete) and a malformed key permanently', async () => {
    const ownerUserId = await createUser(ctx.db);
    const keyless = await queueItem({ ownerUserId, storageKey: null });
    const malformed = await queueItem({ ownerUserId, storageKey: '../escape.mp3' });

    const result = await runProcessDeletionQueue({ db: ctx.db, storage: mock.provider, now: NOW });

    expect(result).toEqual({ deleted: 1, skippedLiveKey: 0, failed: 1 });
    expect((await itemRow(keyless)).processedAt).toEqual(NOW);
    const malformedRow = await itemRow(malformed);
    expect(malformedRow.processedAt).toEqual(NOW); // permanent — never retried
    expect(malformedRow.errorMessageSafe).toBe('invalid storage key');
  });

  it('records a transient failure and leaves the item due for the next run', async () => {
    const ownerUserId = await createUser(ctx.db);
    const key = 'tracks/owner/flaky/original.mp3';
    const id = await queueItem({ ownerUserId, storageKey: key });
    const flakyStorage = {
      ...mock.provider,
      delete: async () => {
        throw new Error('EIO: disk detached');
      },
    };

    const first = await runProcessDeletionQueue({ db: ctx.db, storage: flakyStorage, now: NOW });
    expect(first).toEqual({ deleted: 0, skippedLiveKey: 0, failed: 1 });
    let row = await itemRow(id);
    expect(row.processedAt).toBeNull(); // still due
    expect(row.errorMessageSafe).toBe('storage delete failed'); // raw error never persisted

    // Next run with healthy storage drains it and clears the stale note.
    const second = await runProcessDeletionQueue({ db: ctx.db, storage: mock.provider, now: NOW });
    expect(second).toEqual({ deleted: 1, skippedLiveKey: 0, failed: 0 });
    row = await itemRow(id);
    expect(row.processedAt).toEqual(NOW);
    expect(row.errorMessageSafe).toBeNull();
  });
});
