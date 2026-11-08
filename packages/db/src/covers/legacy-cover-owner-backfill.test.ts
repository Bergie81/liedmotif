import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { canReadCover } from '@liedmotif/shared';
import {
  connectTestDb,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';
import { activitySessions, coverImages } from '../schema';
import { PLACEHOLDER_COVER_ID } from './placeholder';

// Migration 0072 runs ONCE against a real instance's history and cannot be
// re-run to correct a mistake, so the shipped SQL itself is what runs here —
// a wrong join would hand one member's cover art to another member for good.
const BACKFILL_SQL = readFileSync(
  new URL('../../drizzle/0072_legacy_cover_owner_backfill.sql', import.meta.url),
  'utf8',
);

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('legacy cover owner backfill (migration 0072)', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-cover-backfill-test');
  }, 60_000);

  afterAll(async () => {
    await ctx?.pool.end();
  });

  beforeEach(async () => {
    await truncateTables(ctx.pool, [
      'cover_images',
      'playlist_tracks',
      'playlists',
      ...GENERATION_FIXTURE_TABLES,
    ]);
  });

  /** A pre-provenance generated cover: a row nobody is recorded as owning. */
  async function seedOwnerlessCover(id: string): Promise<string> {
    await ctx.db.insert(coverImages).values({
      id,
      sourceType: 'generated',
      storageProvider: 'local-fs',
      storageKey: `covers/${id}.webp`,
    });
    return id;
  }

  /** Give an owner a Session wearing the cover — one ownership pointer at it. */
  async function wearCover(ownerUserId: string, coverImageId: string): Promise<void> {
    const sessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
    await ctx.db
      .update(activitySessions)
      .set({ coverImageId })
      .where(eq(activitySessions.id, sessionId));
  }

  async function provenanceOwnerOf(id: string): Promise<string | null> {
    const [row] = await ctx.db
      .select({ provenance: coverImages.provenance })
      .from(coverImages)
      .where(eq(coverImages.id, id));
    return (row?.provenance as { ownerUserId?: string } | null)?.ownerUserId ?? null;
  }

  async function runBackfill(): Promise<void> {
    await ctx.pool.query(BACKFILL_SQL);
  }

  it('attributes an ownerless cover to the owner of the session wearing it', async () => {
    const owner = await createUser(ctx.db);
    const stranger = await createUser(ctx.db);
    const coverId = await seedOwnerlessCover('11111111-1111-4111-8111-111111111111');
    await wearCover(owner, coverId);

    await runBackfill();

    const provenanceOwnerUserId = await provenanceOwnerOf(coverId);
    expect(provenanceOwnerUserId).toBe(owner);
    const cover = { sourceType: 'generated', provenanceOwnerUserId };
    expect(canReadCover(owner, cover)).toBe(true);
    expect(canReadCover(stranger, cover)).toBe(false);
  });

  it('leaves a cover two owners point at unattributed rather than guessing', async () => {
    const first = await createUser(ctx.db);
    const second = await createUser(ctx.db);
    const coverId = await seedOwnerlessCover('22222222-2222-4222-8222-222222222222');
    await wearCover(first, coverId);
    await wearCover(second, coverId);

    await runBackfill();

    expect(await provenanceOwnerOf(coverId)).toBeNull();
  });

  it('leaves the instance-global placeholder ownerless', async () => {
    const owner = await createUser(ctx.db);
    await ctx.db.insert(coverImages).values({
      id: PLACEHOLDER_COVER_ID,
      sourceType: 'placeholder',
      storageProvider: 'local',
      storageKey: 'covers/placeholder.webp',
    });
    await wearCover(owner, PLACEHOLDER_COVER_ID);

    await runBackfill();

    expect(await provenanceOwnerOf(PLACEHOLDER_COVER_ID)).toBeNull();
    expect(
      canReadCover(await createUser(ctx.db), {
        sourceType: 'placeholder',
        provenanceOwnerUserId: null,
      }),
    ).toBe(true);
  });

  it('never rewrites an owner a cover already names', async () => {
    const owner = await createUser(ctx.db);
    const other = await createUser(ctx.db);
    const coverId = '33333333-3333-4333-8333-333333333333';
    await ctx.db.insert(coverImages).values({
      id: coverId,
      sourceType: 'generated',
      storageProvider: 'local-fs',
      storageKey: `covers/${coverId}.webp`,
      provenance: { ownerUserId: owner },
    });
    await wearCover(other, coverId);

    await runBackfill();

    expect(await provenanceOwnerOf(coverId)).toBe(owner);
  });
});
