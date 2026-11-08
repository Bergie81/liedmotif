import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { user, userProfiles } from '../schema';
import { isAdminUser } from '../setup/state';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { resolveUserProfile } from './resolve-user-profile';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

async function createUser(ctx: TestDb, id: string): Promise<string> {
  await ctx.db.insert(user).values({ id, name: id, email: `${id}@example.test` });
  return id;
}

describeIfDb('user-profile role resolution', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-user-profile-test');
  }, 60_000);

  afterAll(async () => {
    await ctx?.pool.end();
  });

  beforeEach(async () => {
    // Truncating `user` cascades to user_profiles/session/account.
    await truncateTables(ctx.pool, ['user']);
  });

  it('resolves the admin role with a null disabledAt', async () => {
    const userId = await createUser(ctx, 'admin-1');
    await ctx.db.insert(userProfiles).values({ userId, role: 'admin' });

    expect(await resolveUserProfile(ctx.db, userId)).toEqual({ role: 'admin', disabledAt: null });
  });

  it('resolves a member role', async () => {
    const userId = await createUser(ctx, 'member-1');
    await ctx.db.insert(userProfiles).values({ userId, role: 'member' });

    expect(await resolveUserProfile(ctx.db, userId)).toEqual({ role: 'member', disabledAt: null });
  });

  it('returns null for an unknown user id', async () => {
    expect(await resolveUserProfile(ctx.db, 'nobody')).toBeNull();
  });

  it('surfaces disabledAt when set', async () => {
    const disabledAt = new Date('2026-01-02T03:04:05Z');
    const userId = await createUser(ctx, 'member-1');
    await ctx.db.insert(userProfiles).values({ userId, role: 'member', disabledAt });

    expect(await resolveUserProfile(ctx.db, userId)).toEqual({ role: 'member', disabledAt });
  });

  it('keeps isAdminUser answering through the same seam', async () => {
    const adminId = await createUser(ctx, 'admin-1');
    await ctx.db.insert(userProfiles).values({ userId: adminId, role: 'admin' });
    const memberId = await createUser(ctx, 'member-1');
    await ctx.db.insert(userProfiles).values({ userId: memberId, role: 'member' });

    expect(await isAdminUser(ctx.db, adminId)).toBe(true);
    expect(await isAdminUser(ctx.db, memberId)).toBe(false);
  });

  it('still refuses a second admin row while permitting many members', async () => {
    const adminId = await createUser(ctx, 'admin-1');
    await ctx.db.insert(userProfiles).values({ userId: adminId, role: 'admin' });

    const rivalId = await createUser(ctx, 'admin-2');
    await expect(
      ctx.db.insert(userProfiles).values({ userId: rivalId, role: 'admin' }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ constraint: 'user_profiles_single_admin' }),
    });

    for (const id of ['member-1', 'member-2']) {
      const memberId = await createUser(ctx, id);
      await ctx.db.insert(userProfiles).values({ userId: memberId, role: 'member' });
    }
    expect(await resolveUserProfile(ctx.db, 'member-2')).toEqual({
      role: 'member',
      disabledAt: null,
    });
  });
});
