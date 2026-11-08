import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { createSession, createUser, GENERATION_FIXTURE_TABLES } from '../generation/test-fixtures';
import { PLACEHOLDER_COVER_ID, seedPlaceholderCover } from './placeholder';
import { deleteOrphanedCoverImageRows, listOrphanedCoverImages } from './cover-reclaim';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const NOW = new Date('2026-07-28T12:00:00Z');
const OLD = new Date(NOW.getTime() - 48 * 60 * 60 * 1000);
const FRESH = new Date(NOW.getTime() - 60 * 60 * 1000);

describeIfDb('cover-reclaim orphan sweep', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-cover-sweep-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, [
      'playlist_tracks',
      'playlists',
      'cover_images',
      ...GENERATION_FIXTURE_TABLES,
    ]);
  });

  async function insertCover(fx: {
    sourceType?: string;
    createdAt?: Date;
    provenance?: Record<string, string> | null;
  }): Promise<{ id: string; storageKey: string }> {
    const id = crypto.randomUUID();
    const storageKey = `covers/generated/test/${id}.webp`;
    await ctx.pool.query(
      `insert into cover_images (id, source_type, storage_provider, storage_key, provenance, created_at)
       values ($1, $2, 'local-fs', $3, $4, $5)`,
      [
        id,
        fx.sourceType ?? 'generated',
        storageKey,
        fx.provenance === null ? null : JSON.stringify(fx.provenance ?? {}),
        fx.createdAt ?? OLD,
      ],
    );
    return { id, storageKey };
  }

  async function coverExists(id: string): Promise<boolean> {
    const result = await ctx.pool.query('select 1 from cover_images where id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  it('lists an old cover nothing references and drops its row once bytes are gone', async () => {
    const cover = await insertCover({});

    const candidates = await listOrphanedCoverImages(ctx.db, { now: NOW });
    expect(candidates).toEqual([{ coverImageId: cover.id, storageKey: cover.storageKey }]);

    const deleted = await deleteOrphanedCoverImageRows(ctx.db, {
      coverImageIds: [cover.id],
      now: NOW,
    });
    expect(deleted.map((row) => row.coverImageId)).toEqual([cover.id]);
    expect(await coverExists(cover.id)).toBe(false);
  });

  it('refuses the row delete for a cover that got referenced after the gather', async () => {
    const ownerUserId = await createUser(ctx.db);
    const cover = await insertCover({});
    const candidates = await listOrphanedCoverImages(ctx.db, { now: NOW });
    expect(candidates.map((c) => c.coverImageId)).toEqual([cover.id]);
    await createSession(ctx.db, { ownerUserId, status: 'stopped', coverImageId: cover.id });

    const deleted = await deleteOrphanedCoverImageRows(ctx.db, {
      coverImageIds: [cover.id],
      now: NOW,
    });
    expect(deleted).toEqual([]);
    expect(await coverExists(cover.id)).toBe(true);
  });

  it('keeps covers that are referenced, recent, subject-owned, or the placeholder', async () => {
    const ownerUserId = await createUser(ctx.db);
    // Referenced by a session's current-cover pointer.
    const sessionCover = await insertCover({});
    await createSession(ctx.db, { ownerUserId, status: 'stopped', coverImageId: sessionCover.id });
    // Uploaded, provenance names a session that still exists.
    const sessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
    const uploaded = await insertCover({
      sourceType: 'uploaded',
      provenance: { ownerUserId, activitySessionId: sessionId },
    });
    // Younger than the safety margin.
    const fresh = await insertCover({ createdAt: FRESH });
    // The built-in placeholder.
    await seedPlaceholderCover(ctx.db);

    const candidates = await listOrphanedCoverImages(ctx.db, { now: NOW });

    expect(candidates).toEqual([]);
    expect(await coverExists(sessionCover.id)).toBe(true);
    expect(await coverExists(uploaded.id)).toBe(true);
    expect(await coverExists(fresh.id)).toBe(true);
    expect(await coverExists(PLACEHOLDER_COVER_ID)).toBe(true);
  });

  it('sweeps an uploaded cover whose provenance subject no longer exists', async () => {
    const orphanUpload = await insertCover({
      sourceType: 'uploaded',
      provenance: { ownerUserId: 'gone', activitySessionId: crypto.randomUUID() },
    });

    const candidates = await listOrphanedCoverImages(ctx.db, { now: NOW });

    expect(candidates.map((c) => c.coverImageId)).toEqual([orphanUpload.id]);
  });

  it('keeps a cover held only by a living subject’s generated history', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
    const historyCover = await insertCover({});
    await ctx.pool.query(
      `insert into session_cover_generations
         (id, owner_user_id, activity_session_id, state, plan, plan_version, prompt_version,
          plan_hash, prompt_hash, fingerprint, provider_key, model, capability_snapshot,
          idempotency_key, retry_policy, cover_image_id, storage_key)
       values ($1, $2, $3, 'ready', '{}', 'v', 'v', $4, $5, '{}', 'test', 'test', '{}', $6, '{}', $7, $8)`,
      [
        crypto.randomUUID(),
        ownerUserId,
        sessionId,
        `plan-${historyCover.id}`,
        `prompt-${historyCover.id}`,
        `cover:${historyCover.id}`,
        historyCover.id,
        historyCover.storageKey,
      ],
    );

    const candidates = await listOrphanedCoverImages(ctx.db, { now: NOW });

    expect(candidates).toEqual([]);
    expect(await coverExists(historyCover.id)).toBe(true);
  });
});
