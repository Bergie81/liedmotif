import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MEMBER_LIMITS,
  DEFAULT_MEMBERS_POOL,
  DEFAULT_ONBOARDING_STATE,
  DEFAULT_PLAYBACK_SETTINGS,
} from '@liedmotif/shared';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { createUser } from '../generation/test-fixtures';
import { defaultUsageLimits, user, userProfiles } from '../schema';
import { getMembersPool, getUsageLimits, updateMembersPool } from '../setup/settings';
import {
  completeOnboarding,
  getMemberLimits,
  getOnboardingState,
  getPlaybackSettings,
  listMemberLimits,
  updateMemberLimits,
  updatePlaybackSettings,
} from './user-settings-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('user-settings repo — playback', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-user-settings-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, ['user_settings', 'user']);
  });

  it('answers the shipped defaults before anything is stored', async () => {
    const ownerUserId = await createUser(ctx.db);
    expect(await getPlaybackSettings(ctx.db, ownerUserId)).toEqual(DEFAULT_PLAYBACK_SETTINGS);
    expect(DEFAULT_PLAYBACK_SETTINGS).toEqual({ blendEnabled: true, crossfadeSeconds: 6 });
  });

  it('applies a partial patch and keeps unspecified fields', async () => {
    const ownerUserId = await createUser(ctx.db);

    const afterCrossfade = await updatePlaybackSettings(ctx.db, {
      ownerUserId,
      patch: { crossfadeSeconds: 9 },
    });
    expect(afterCrossfade).toEqual({ blendEnabled: true, crossfadeSeconds: 9 });

    const afterToggle = await updatePlaybackSettings(ctx.db, {
      ownerUserId,
      patch: { blendEnabled: false },
    });
    expect(afterToggle).toEqual({ blendEnabled: false, crossfadeSeconds: 9 });
    expect(await getPlaybackSettings(ctx.db, ownerUserId)).toEqual(afterToggle);
  });

  it('concurrent FIRST-ROW patches to different fields both survive', async () => {
    const ownerUserId = await createUser(ctx.db);
    // No row exists yet: both patches race on creating it. The atomic
    // `value || patch` conflict merge must preserve both fields, whichever wins
    // the insert.
    await Promise.all([
      updatePlaybackSettings(ctx.db, { ownerUserId, patch: { blendEnabled: false } }),
      updatePlaybackSettings(ctx.db, { ownerUserId, patch: { crossfadeSeconds: 10 } }),
    ]);
    expect(await getPlaybackSettings(ctx.db, ownerUserId)).toEqual({
      blendEnabled: false,
      crossfadeSeconds: 10,
    });
  });

  it('is owner-scoped: one owner’s settings never leak into another’s', async () => {
    const a = await createUser(ctx.db);
    const b = await createUser(ctx.db);
    await updatePlaybackSettings(ctx.db, { ownerUserId: a, patch: { crossfadeSeconds: 2 } });

    expect(await getPlaybackSettings(ctx.db, b)).toEqual(DEFAULT_PLAYBACK_SETTINGS);
  });
});

describeIfDb('user-settings repo — onboarding', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-user-settings-onboarding-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, ['user_settings', 'user']);
  });

  it('reports an owner who has never onboarded', async () => {
    const ownerUserId = await createUser(ctx.db);
    expect(await getOnboardingState(ctx.db, ownerUserId)).toEqual(DEFAULT_ONBOARDING_STATE);
    expect(DEFAULT_ONBOARDING_STATE).toEqual({ completedAt: null });
  });

  it('stamps completion as an ISO timestamp the guard can read back', async () => {
    const ownerUserId = await createUser(ctx.db);
    const completed = await completeOnboarding(ctx.db, ownerUserId);

    expect(completed.completedAt).not.toBeNull();
    expect(new Date(completed.completedAt!).toISOString()).toBe(completed.completedAt);
    expect(await getOnboardingState(ctx.db, ownerUserId)).toEqual(completed);
  });

  it('does not onboard a second owner along with the first', async () => {
    const a = await createUser(ctx.db);
    const b = await createUser(ctx.db);
    await completeOnboarding(ctx.db, a);

    expect(await getOnboardingState(ctx.db, b)).toEqual(DEFAULT_ONBOARDING_STATE);
  });

  it('leaves other keys for the same owner untouched', async () => {
    const ownerUserId = await createUser(ctx.db);
    await updatePlaybackSettings(ctx.db, { ownerUserId, patch: { crossfadeSeconds: 11 } });
    await completeOnboarding(ctx.db, ownerUserId);

    expect(await getPlaybackSettings(ctx.db, ownerUserId)).toEqual({
      blendEnabled: true,
      crossfadeSeconds: 11,
    });
  });
});

describeIfDb('user-settings repo — member limits (Invite Mode)', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-member-limits-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, ['user_settings', 'user']);
  });

  async function createMember(id: string): Promise<string> {
    await ctx.db.insert(user).values({ id, name: id, email: `${id}@example.test` });
    await ctx.db.insert(userProfiles).values({ userId: id, role: 'member' });
    return id;
  }

  it('caps a fresh Member by the defaults, never uncapped', async () => {
    const memberId = await createMember('member-1');
    expect(await getMemberLimits(ctx.db, memberId)).toEqual(DEFAULT_MEMBER_LIMITS);
  });

  it('round-trips a partial budget patch', async () => {
    const memberId = await createMember('member-1');
    const updated = await updateMemberLimits(ctx.db, {
      ownerUserId: memberId,
      patch: { dailyGenerationTasks: 4, generatedCoversPerDay: 2 },
    });
    expect(updated).toEqual({
      ...DEFAULT_MEMBER_LIMITS,
      dailyGenerationTasks: 4,
      generatedCoversPerDay: 2,
    });
    expect(await getMemberLimits(ctx.db, memberId)).toEqual(updated);
  });

  it('lists every Member with defaults merged, and never the admin', async () => {
    await ctx.db.insert(user).values({ id: 'admin-1', name: 'a', email: 'a@example.test' });
    await ctx.db.insert(userProfiles).values({ userId: 'admin-1', role: 'admin' });
    const first = await createMember('member-1');
    const second = await createMember('member-2');
    await updateMemberLimits(ctx.db, {
      ownerUserId: second,
      patch: { monthlyGenerationTasks: 80 },
    });

    expect(await listMemberLimits(ctx.db)).toEqual([
      { userId: first, limits: DEFAULT_MEMBER_LIMITS },
      { userId: second, limits: { ...DEFAULT_MEMBER_LIMITS, monthlyGenerationTasks: 80 } },
    ]);
  });
});

describeIfDb('app-settings repo — members pool (Invite Mode)', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-members-pool-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, ['app_settings']);
  });

  it('answers the defaults before anything is stored', async () => {
    expect(await getMembersPool(ctx.db)).toEqual(DEFAULT_MEMBERS_POOL);
  });

  it('round-trips a partial Pool patch without touching the admin limits', async () => {
    const updated = await updateMembersPool(ctx.db, { dailyGenerationTasks: 10 });
    expect(updated).toEqual({ ...DEFAULT_MEMBERS_POOL, dailyGenerationTasks: 10 });
    expect(await getUsageLimits(ctx.db)).toEqual(defaultUsageLimits());
  });
});
