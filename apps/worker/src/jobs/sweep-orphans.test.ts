import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { coverImages, tracks } from '@liedmotif/db';
import { eq } from 'drizzle-orm';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { createMockStorageProvider, type MockStorage } from '@liedmotif/storage';
import { runSweepOrphans } from './sweep-orphans';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const NOW = new Date('2026-07-28T12:00:00Z');
const OLD = new Date(NOW.getTime() - 48 * 60 * 60 * 1000);

describeIfDb('sweep-orphans job', () => {
  let ctx: TestDb;
  let mock: MockStorage;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-sweep-orphans-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
    await mock?.cleanup();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, ['cover_images', ...GENERATION_FIXTURE_TABLES]);
    await mock?.cleanup();
    mock = createMockStorageProvider();
  });

  /** An old cover row referenced by nothing — the sweep's cover candidate. */
  async function insertOrphanCover(): Promise<{ coverImageId: string; storageKey: string }> {
    const coverImageId = crypto.randomUUID();
    const storageKey = `covers/generated/test/${coverImageId}.webp`;
    await ctx.db.insert(coverImages).values({
      id: coverImageId,
      sourceType: 'generated',
      storageProvider: 'local-fs',
      storageKey,
      provenance: {},
      createdAt: OLD,
    });
    return { coverImageId, storageKey };
  }

  it('reclaims an orphan track and an orphan cover, deleting the cover bytes directly', async () => {
    const ownerUserId = await createUser(ctx.db);
    // Orphan track: request without a session edge, ready, unsaved.
    const requestId = await createGenerationRequest(ctx.db, { ownerUserId });
    const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
    const trackId = await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      status: 'ready',
      audioStorageKey: 'audio/orphan.mp3',
    });
    // Orphan cover with its bytes present in storage.
    const { storageKey } = await insertOrphanCover();
    await mock.provider.write({
      key: storageKey,
      body: new Uint8Array([1, 2, 3]),
      mimeType: 'image/webp',
    });

    const result = await runSweepOrphans({ db: ctx.db, storage: mock.provider, now: NOW });

    expect(result).toEqual({
      tracksReclaimed: 1,
      coversReclaimed: 1,
      coverByteDeleteFailures: 0,
      interruptedWritesReclaimed: 0,
      storageBytes: expect.any(Number),
    });
    const [row] = await ctx.db.select().from(tracks).where(eq(tracks.id, trackId));
    expect(row!.status).toBe('deleted');
    expect(await mock.provider.stat(storageKey)).toBeNull();

    // Second run: nothing left to find.
    expect(await runSweepOrphans({ db: ctx.db, storage: mock.provider, now: NOW })).toEqual({
      tracksReclaimed: 0,
      coversReclaimed: 0,
      coverByteDeleteFailures: 0,
      interruptedWritesReclaimed: 0,
      storageBytes: expect.any(Number),
    });
  });

  it('unlinks a staged write a killed process stranded, sparing a fresh one', async () => {
    const dir = path.join(mock.dataRoot, 'tracks/u/t');
    await mkdir(dir, { recursive: true });
    const stale = path.join(dir, 'original.mp3.a1b2c3d4e5f6.tmp');
    const fresh = path.join(dir, 'original.mp3.0f1e2d3c4b5a.tmp');
    await writeFile(stale, 'half a download');
    await writeFile(fresh, 'still writing');
    const longAgo = new Date(NOW.getTime() - 72 * 60 * 60 * 1000);
    await utimes(stale, longAgo, longAgo);
    await utimes(fresh, NOW, NOW);

    const result = await runSweepOrphans({ db: ctx.db, storage: mock.provider, now: NOW });

    expect(result.interruptedWritesReclaimed).toBe(1);
    expect(await readdir(dir)).toEqual([path.basename(fresh)]);
  });

  it('keeps the row when the byte delete fails, so the next run retries', async () => {
    const { coverImageId } = await insertOrphanCover();
    const failing = {
      ...mock.provider,
      delete: async () => {
        throw new Error('disk detached');
      },
    };

    const result = await runSweepOrphans({ db: ctx.db, storage: failing, now: NOW });

    expect(result).toEqual({
      tracksReclaimed: 0,
      coversReclaimed: 0,
      coverByteDeleteFailures: 1,
      interruptedWritesReclaimed: 0,
      storageBytes: expect.any(Number),
    });
    const [row] = await ctx.db.select().from(coverImages).where(eq(coverImages.id, coverImageId));
    expect(row).toBeDefined();

    // Storage recovered: the retry reclaims row and bytes.
    const retry = await runSweepOrphans({ db: ctx.db, storage: mock.provider, now: NOW });
    expect(retry.coversReclaimed).toBe(1);
  });
});
