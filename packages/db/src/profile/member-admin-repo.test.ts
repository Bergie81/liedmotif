// The Members administration reads/writes: aggregate-only account
// rows (counts, bytes, dates — never content) and the immediate,
// reversible disable that also revokes live login rows.

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
import { people, personReferencePhotos, session, trackAudioAssets, userProfiles } from '../schema';
import { resolveUserProfile } from './resolve-user-profile';
import { listMemberAccounts, setMemberDisabled } from './member-admin-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('members administration repo', () => {
  let ctx: TestDb;
  let adminId: string;
  let memberId: string;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-member-admin-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, [...GENERATION_FIXTURE_TABLES, 'people', 'session']);
    memberSessionId = null;
    adminId = await createUser(ctx.db);
    memberId = await createUser(ctx.db);
    await ctx.db.insert(userProfiles).values([
      { userId: adminId, role: 'admin' },
      { userId: memberId, role: 'member' },
    ]);
  });

  let memberSessionId: string | null = null;
  async function seedMemberTrack(byteSize: number, status: 'ready' | 'deleted' = 'ready') {
    memberSessionId ??= await createSession(ctx.db, { ownerUserId: memberId });
    const sessionId = memberSessionId;
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId: memberId,
      activitySessionId: sessionId,
    });
    const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
    const trackId = await createTrack(ctx.db, {
      ownerUserId: memberId,
      generationRequestId: requestId,
      providerJobId: jobId,
      status,
    });
    await ctx.db.insert(trackAudioAssets).values({
      trackId,
      assetType: 'local_original',
      storageProvider: 'local-fs',
      storageKey: `tracks/${memberId}/${trackId}.mp3`,
      byteSize,
      isPlayable: true,
    });
    return trackId;
  }

  it('aggregates counts, bytes, and dates per Member — and only Members', async () => {
    await seedMemberTrack(1_000);
    await seedMemberTrack(2_500);
    await seedMemberTrack(9_999, 'deleted');
    const [person] = await ctx.db
      .insert(people)
      .values({
        ownerUserId: memberId,
        role: 'ordinary',
        name: 'Nana',
        nameMatchKey: 'nana',
        sortOrder: 1,
      })
      .returning();
    await ctx.db.insert(personReferencePhotos).values({
      ownerUserId: memberId,
      personId: person!.id,
      storageProvider: 'local-fs',
      storageKey: `person-references/${memberId}/${person!.id}/p1.webp`,
      mediaType: 'image/webp',
      byteSize: 500,
    });
    await ctx.db.insert(session).values({
      id: 'sess-1',
      token: 'tok-1',
      userId: memberId,
      expiresAt: new Date(Date.now() + 3_600_000),
      updatedAt: new Date('2026-07-29T10:00:00Z'),
    });

    const rows = await listMemberAccounts(ctx.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: memberId,
      name: 'Test Admin',
      disabledAt: null,
      trackCount: 2,
      storageBytes: 4_000,
    });
    expect(rows[0]!.lastActiveAt?.toISOString()).toBe('2026-07-29T10:00:00.000Z');
    expect(rows[0]!.joinedAt).toBeInstanceOf(Date);
  });

  it('answers zeroes for a fresh Member with no content or logins', async () => {
    const rows = await listMemberAccounts(ctx.db);
    expect(rows).toEqual([
      expect.objectContaining({
        userId: memberId,
        trackCount: 0,
        storageBytes: 0,
        lastActiveAt: null,
      }),
    ]);
  });

  it('disable stamps disabledAt, revokes login rows, and keeps everything else', async () => {
    await seedMemberTrack(1_000);
    await ctx.db.insert(session).values({
      id: 'sess-live',
      token: 'tok-live',
      userId: memberId,
      expiresAt: new Date(Date.now() + 3_600_000),
      updatedAt: new Date(),
    });

    expect(await setMemberDisabled(ctx.db, { userId: memberId, disabled: true })).toBe(true);
    expect((await resolveUserProfile(ctx.db, memberId))?.disabledAt).not.toBeNull();
    expect(await ctx.db.select().from(session).where(eq(session.userId, memberId))).toHaveLength(0);
    expect((await listMemberAccounts(ctx.db))[0]!.trackCount).toBe(1);

    expect(await setMemberDisabled(ctx.db, { userId: memberId, disabled: false })).toBe(true);
    expect((await resolveUserProfile(ctx.db, memberId))?.disabledAt).toBeNull();
  });

  it('refuses to disable the Admin or an unknown user', async () => {
    expect(await setMemberDisabled(ctx.db, { userId: adminId, disabled: true })).toBe(false);
    expect(await setMemberDisabled(ctx.db, { userId: 'nobody', disabled: true })).toBe(false);
    expect((await resolveUserProfile(ctx.db, adminId))?.disabledAt).toBeNull();
  });
});
