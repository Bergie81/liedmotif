// Member and Pool cover budgets: cover
// admission requires BOTH the Member's cover caps and the Pool's, counted by
// the same conservative predicate as the per-owner read; uploads and Admin
// attempts never touch the Pool.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionCoverPlanRecord } from '../schema';
import { defaultUsageLimits } from '../schema/settings';
import { coverImages, sessionCoverGenerations, user, userProfiles } from '../schema';
import { updateMemberLimits } from '../settings/user-settings-repo';
import { updateMembersPool } from '../setup/settings';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { withTransaction } from '../transactions';
import { coverAdmissionDecision, coverUsageView, getAdminCoverUsage, getCoverUsage } from './usage';
import { POOL_SCOPE } from '../member-pool';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;
const NOW = new Date('2026-06-29T12:00:00Z');
const LIMITS = defaultUsageLimits('UTC');

const FIXTURE_PLAN: SessionCoverPlanRecord = {
  sessionName: 'Budget fixture',
  coverConcept: null,
  selectedStyle: 'minimal',
  resolvedStyle: 'minimal',
  customDefinition: null,
  styleFallbackReason: null,
  concreteScene: 'one controlled scene',
  semanticCueIds: ['name:exact'],
  conceptMode: 'title symbol',
  subjectFamily: 'one controlled subject',
  composition: 'one controlled composition',
  palette: 'one controlled palette',
  material: 'one controlled material',
  lighting: 'one controlled light',
  referenceTreatment: null,
  prompt: 'private prompt',
  exclusions: [],
  altText: 'Budget fixture',
  candidateCount: 1,
  diversityRelaxedAxes: [],
};

describeIfDb('cover budgets — member and pool scopes', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-cover-pool-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, [
      'session_cover_generations',
      'cover_images',
      'user_settings',
      'app_settings',
      'user',
    ]);
  });

  async function createProfiledUser(
    role: 'admin' | 'member',
    opts: { disabledAt?: Date } = {},
  ): Promise<string> {
    const id = `user-${randomUUID()}`;
    await ctx.db.insert(user).values({ id, name: id, email: `${id}@example.test` });
    await ctx.db.insert(userProfiles).values({ userId: id, role, disabledAt: opts.disabledAt });
    return id;
  }

  /** One counted (possibly-paid) cover attempt for `ownerUserId`, at NOW by default. */
  async function spendCover(ownerUserId: string, createdAt: Date = NOW): Promise<void> {
    const id = randomUUID();
    await ctx.db.insert(sessionCoverGenerations).values({
      id,
      ownerUserId,
      activitySessionId: null,
      state: 'reserved',
      plan: FIXTURE_PLAN,
      planVersion: 'test-plan',
      promptVersion: 'test-prompt',
      planHash: `plan-${id}`,
      promptHash: `prompt-${id}`,
      fingerprint: {},
      providerKey: 'test-provider',
      model: 'test-model',
      capabilitySnapshot: {},
      idempotencyKey: `cover-${id}`,
      retryPolicy: { version: 'test' },
      coverImageId: randomUUID(),
      storageKey: `covers/${id}.webp`,
      createdAt,
    });
  }

  function admit(ownerUserId: string) {
    return withTransaction(ctx.db, (tx) =>
      coverAdmissionDecision(tx, { ownerUserId, instanceLimits: LIMITS, now: NOW }),
    );
  }

  it('refuses a member with personal cover headroom when the pool covers are exhausted', async () => {
    const other = await createProfiledUser('member');
    await spendCover(other);
    await updateMembersPool(ctx.db, { generatedCoversPerDay: 1, generatedCoversPerMonth: 10 });

    const memberId = await createProfiledUser('member');
    const decision = await admit(memberId);
    expect(decision).toEqual({ admitted: false, reason: 'budget', window: 'day', scope: 'pool' });
  });

  it('refuses a member exhausted personally while the pool is open', async () => {
    const memberId = await createProfiledUser('member');
    await updateMemberLimits(ctx.db, {
      ownerUserId: memberId,
      patch: { generatedCoversPerDay: 1, generatedCoversPerMonth: 10 },
    });
    await spendCover(memberId);

    const decision = await admit(memberId);
    expect(decision).toEqual({ admitted: false, reason: 'budget', window: 'day', scope: 'member' });
  });

  it('admits the admin with the pool exhausted, and keeps admin attempts out of the pool count', async () => {
    await updateMembersPool(ctx.db, { generatedCoversPerDay: 0, generatedCoversPerMonth: 0 });
    const adminId = await createProfiledUser('admin');
    await spendCover(adminId);

    expect((await admit(adminId)).admitted).toBe(true);
    const pool = await getCoverUsage(ctx.db, {
      scope: POOL_SCOPE,
      caps: { generatedCoversPerDay: 30, generatedCoversPerMonth: 200 },
      resetTimezone: 'UTC',
      now: NOW,
    });
    expect(pool.usedDay).toBe(0);
  });

  it('admits the admin past their day cap with the Cover ceiling off, and reports no limit', async () => {
    const adminId = await createProfiledUser('admin');
    await spendCover(adminId);
    const instanceLimits = {
      ...LIMITS,
      coverCeilingEnabled: false,
      generatedCoversPerDay: 1,
      generatedCoversPerMonth: 1,
    };

    const decision = await withTransaction(ctx.db, (tx) =>
      coverAdmissionDecision(tx, { ownerUserId: adminId, instanceLimits, now: NOW }),
    );
    expect(decision).toEqual({ admitted: true });

    const view = await coverUsageView(ctx.db, { ownerUserId: adminId, instanceLimits, now: NOW });
    expect(view).toEqual({
      usage: { usedDay: 1, usedMonth: 1, limitDay: null, limitMonth: null, oneTime: false },
      remaining: null,
    });
    expect(
      await getAdminCoverUsage(ctx.db, {
        ownerUserId: adminId,
        instanceLimits,
        now: NOW,
        concurrently: true,
      }),
    ).toEqual({ usedDay: 1, usedMonth: 1, limitDay: null, limitMonth: null });
  });

  // A disable is not a budget that refills, so it must not be reported as one —
  // the refusal names the account, not a window the Member could wait out.
  it('refuses a disabled member outright, naming the account and not a budget', async () => {
    const memberId = await createProfiledUser('member', { disabledAt: NOW });
    expect(await admit(memberId)).toEqual({ admitted: false, reason: 'account_disabled' });
  });

  it('refuses a disabled ADMIN by the account too, never by a member-scoped budget', async () => {
    const adminId = await createProfiledUser('admin', { disabledAt: NOW });
    expect(await admit(adminId)).toEqual({ admitted: false, reason: 'account_disabled' });
  });

  it('admits exactly one of two concurrent member attempts racing one remaining pool cover', async () => {
    await updateMembersPool(ctx.db, { generatedCoversPerDay: 1, generatedCoversPerMonth: 10 });
    const memberA = await createProfiledUser('member');
    const memberB = await createProfiledUser('member');

    // Mimic the real admission shape: decide under the lock, and insert the
    // reservation (the row the counts see) before the lock releases.
    const attempt = (ownerUserId: string) =>
      withTransaction(ctx.db, async (tx) => {
        const decision = await coverAdmissionDecision(tx, {
          ownerUserId,
          instanceLimits: LIMITS,
          now: NOW,
        });
        if (!decision.admitted) return false;
        const id = randomUUID();
        await tx.insert(sessionCoverGenerations).values({
          id,
          ownerUserId,
          activitySessionId: null,
          state: 'reserved',
          plan: FIXTURE_PLAN,
          planVersion: 'test-plan',
          promptVersion: 'test-prompt',
          planHash: `plan-${id}`,
          promptHash: `prompt-${id}`,
          fingerprint: {},
          providerKey: 'test-provider',
          model: 'test-model',
          capabilitySnapshot: {},
          idempotencyKey: `cover-${id}`,
          retryPolicy: { version: 'test' },
          coverImageId: randomUUID(),
          storageKey: `covers/${id}.webp`,
          createdAt: NOW,
        });
        return true;
      });

    const results = await Promise.all([attempt(memberA), attempt(memberB)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('never counts an upload against either budget', async () => {
    const memberId = await createProfiledUser('member');
    await ctx.db.insert(coverImages).values({
      sourceType: 'uploaded',
      storageProvider: 'local-fs',
      storageKey: `covers/uploaded/${memberId}/${randomUUID()}.webp`,
      publicPath: '',
      provenance: { ownerUserId: memberId },
      createdAt: NOW,
    });

    const view = await coverUsageView(ctx.db, {
      ownerUserId: memberId,
      instanceLimits: LIMITS,
      now: NOW,
    });
    expect(view.usage.usedDay).toBe(0);
    const pool = await getCoverUsage(ctx.db, {
      scope: POOL_SCOPE,
      caps: { generatedCoversPerDay: 30, generatedCoversPerMonth: 200 },
      resetTimezone: 'UTC',
      now: NOW,
    });
    expect(pool.usedDay).toBe(0);
  });

  it("tightens a member's advisory remaining by the pool", async () => {
    const other = await createProfiledUser('member');
    await spendCover(other);
    await spendCover(other);
    await updateMembersPool(ctx.db, { generatedCoversPerDay: 3, generatedCoversPerMonth: 10 });

    const memberId = await createProfiledUser('member');
    const view = await coverUsageView(ctx.db, {
      ownerUserId: memberId,
      instanceLimits: LIMITS,
      now: NOW,
    });
    // Member defaults allow 10/day, but the pool has 1 left.
    expect(view.usage.limitDay).toBe(10);
    expect(view.remaining).toBe(1);
  });
  // A One-time cover budget: one total counted since the Grant, still inside
  // the Pool's day/month windows.
  describe('One-time budgets', () => {
    const GRANT = new Date('2026-06-20T00:00:00Z');

    async function oneTimeMember(totalGeneratedCovers: number): Promise<string> {
      const memberId = await createProfiledUser('member');
      await updateMemberLimits(ctx.db, {
        ownerUserId: memberId,
        patch: { kind: 'oneTime', totalGeneratedCovers, grantedAt: GRANT.toISOString() },
      });
      return memberId;
    }

    it('admits while the total has headroom, whatever the dormant day cap says', async () => {
      const memberId = await oneTimeMember(2);
      await updateMemberLimits(ctx.db, {
        ownerUserId: memberId,
        patch: { generatedCoversPerDay: 0, generatedCoversPerMonth: 0 },
      });
      await spendCover(memberId);
      expect(await admit(memberId)).toEqual({ admitted: true });
    });

    it('refuses on the total window naming the member once the total is used', async () => {
      const memberId = await oneTimeMember(1);
      await spendCover(memberId);
      expect(await admit(memberId)).toEqual({
        admitted: false,
        reason: 'budget',
        window: 'total',
        scope: 'member',
      });
    });

    it('counts only covers since the Grant', async () => {
      const memberId = await oneTimeMember(1);
      await spendCover(memberId, new Date(GRANT.getTime() - 1000));
      expect(await admit(memberId)).toEqual({ admitted: true });
      const view = await coverUsageView(ctx.db, {
        ownerUserId: memberId,
        instanceLimits: LIMITS,
        now: NOW,
      });
      expect(view.remaining).toBe(1);
    });

    it('is refused by the pool when only the pool binds', async () => {
      const other = await createProfiledUser('member');
      await spendCover(other);
      await updateMembersPool(ctx.db, { generatedCoversPerDay: 1, generatedCoversPerMonth: 10 });
      const memberId = await oneTimeMember(10);
      expect(await admit(memberId)).toEqual({
        admitted: false,
        reason: 'budget',
        window: 'day',
        scope: 'pool',
      });
    });
  });
});
