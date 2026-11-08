import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEMBER_LIMITS,
  DEFAULT_MEMBERS_POOL,
  memberLimitsSchema,
  foreignKindFields,
  membersPoolSchema,
  poolOverSubscription,
  updateMemberLimitsRequestSchema,
} from './member-budgets';
import { USAGE_LIMIT_CEILINGS } from './usage-limit-ceilings';

describe('member budget schemas', () => {
  it('ships the defaults (tasks in, tracks out: 20/100 per member, 50/250 pooled)', () => {
    expect(memberLimitsSchema.parse(DEFAULT_MEMBER_LIMITS)).toEqual(DEFAULT_MEMBER_LIMITS);
    expect(membersPoolSchema.parse(DEFAULT_MEMBERS_POOL)).toEqual(DEFAULT_MEMBERS_POOL);
    // 2 tracks per call: 10/50 tasks = 20 tracks/day, 100/month.
    expect(DEFAULT_MEMBER_LIMITS.dailyGenerationTasks * 2).toBe(20);
    expect(DEFAULT_MEMBER_LIMITS.monthlyGenerationTasks * 2).toBe(100);
    expect(DEFAULT_MEMBERS_POOL.dailyGenerationTasks * 2).toBe(50);
    expect(DEFAULT_MEMBERS_POOL.monthlyGenerationTasks * 2).toBe(250);
  });

  it('rejects negatives and non-integers', () => {
    expect(
      memberLimitsSchema.safeParse({ ...DEFAULT_MEMBER_LIMITS, dailyGenerationTasks: -1 }).success,
    ).toBe(false);
    expect(
      membersPoolSchema.safeParse({ ...DEFAULT_MEMBERS_POOL, generatedCoversPerDay: 1.5 }).success,
    ).toBe(false);
  });

  it('rejects a monthly cap below the daily one, for tracks and covers alike', () => {
    expect(
      memberLimitsSchema.safeParse({
        ...DEFAULT_MEMBER_LIMITS,
        dailyGenerationTasks: 10,
        monthlyGenerationTasks: 9,
      }).success,
    ).toBe(false);
    expect(
      membersPoolSchema.safeParse({
        ...DEFAULT_MEMBERS_POOL,
        generatedCoversPerDay: 30,
        generatedCoversPerMonth: 29,
      }).success,
    ).toBe(false);
  });

  it('refuses a budget above the instance ceiling, and accepts the ceiling itself', () => {
    // Without a ceiling one admin typo sets a Member's spend window to any
    // integer — the cost controls switched off from the inside.
    const ceiling = USAGE_LIMIT_CEILINGS.dailyGenerationTasks;
    expect(
      memberLimitsSchema.safeParse({
        ...DEFAULT_MEMBER_LIMITS,
        dailyGenerationTasks: ceiling,
        monthlyGenerationTasks: USAGE_LIMIT_CEILINGS.monthlyGenerationTasks,
      }).success,
    ).toBe(true);
    expect(
      memberLimitsSchema.safeParse({ ...DEFAULT_MEMBER_LIMITS, dailyGenerationTasks: ceiling + 1 })
        .success,
    ).toBe(false);
    expect(
      membersPoolSchema.safeParse({ ...DEFAULT_MEMBERS_POOL, maxConcurrentJobs: 1_000 }).success,
    ).toBe(false);
  });

  it('allows zero windows with intent (0 = no generation at all)', () => {
    const zeroed = {
      dailyGenerationTasks: 0,
      monthlyGenerationTasks: 0,
      maxConcurrentJobs: 1,
      maxQueuedTracks: 1,
      generatedCoversPerDay: 0,
      generatedCoversPerMonth: 0,
    };
    expect(memberLimitsSchema.safeParse(zeroed).success).toBe(true);
  });

  it('refuses a concurrency of 0 and accepts 1, for a Member and the Pool alike', () => {
    // A Session whose owner may run no provider call at all never fills and
    // never says why; a budget of 0 Tracks is the way to block generation.
    expect(
      memberLimitsSchema.safeParse({ ...DEFAULT_MEMBER_LIMITS, maxConcurrentJobs: 0 }).success,
    ).toBe(false);
    expect(updateMemberLimitsRequestSchema.safeParse({ maxConcurrentJobs: 0 }).success).toBe(false);
    expect(updateMemberLimitsRequestSchema.safeParse({ maxConcurrentJobs: 1 }).success).toBe(true);
    expect(
      membersPoolSchema.safeParse({ ...DEFAULT_MEMBERS_POOL, maxConcurrentJobs: 0 }).success,
    ).toBe(false);
    expect(
      membersPoolSchema.safeParse({ ...DEFAULT_MEMBERS_POOL, maxConcurrentJobs: 1 }).success,
    ).toBe(true);
  });

  it('refuses a queue depth of 0 and accepts 1', () => {
    // Revision fills and Dislike rerolls spend whatever the queue depth says,
    // so 0 could never mean "nothing queued".
    expect(
      memberLimitsSchema.safeParse({ ...DEFAULT_MEMBER_LIMITS, maxQueuedTracks: 0 }).success,
    ).toBe(false);
    expect(
      memberLimitsSchema.safeParse({ ...DEFAULT_MEMBER_LIMITS, maxQueuedTracks: 1 }).success,
    ).toBe(true);
    expect(updateMemberLimitsRequestSchema.safeParse({ maxQueuedTracks: 0 }).success).toBe(false);
    expect(updateMemberLimitsRequestSchema.safeParse({ maxQueuedTracks: 1 }).success).toBe(true);
  });
});

describe('poolOverSubscription', () => {
  it('reports nothing when Σ member budgets fit the pool', () => {
    expect(poolOverSubscription([DEFAULT_MEMBER_LIMITS], DEFAULT_MEMBERS_POOL)).toEqual([]);
  });

  it('reports each over-subscribed window with the totals', () => {
    const members = Array.from({ length: 6 }, () => DEFAULT_MEMBER_LIMITS);
    expect(poolOverSubscription(members, DEFAULT_MEMBERS_POOL)).toEqual([
      { field: 'dailyGenerationTasks', membersTotal: 60, poolCap: 25 },
      { field: 'monthlyGenerationTasks', membersTotal: 300, poolCap: 125 },
      { field: 'generatedCoversPerDay', membersTotal: 60, poolCap: 25 },
      { field: 'generatedCoversPerMonth', membersTotal: 150, poolCap: 125 },
    ]);
  });

  it('never reports concurrency (Σ member concurrency over the pool is normal)', () => {
    const members = Array.from({ length: 4 }, () => DEFAULT_MEMBER_LIMITS);
    const fields = poolOverSubscription(members, DEFAULT_MEMBERS_POOL).map((o) => o.field);
    expect(fields).not.toContain('maxConcurrentJobs');
  });

  it('sums Rolling Members only — a One-time total has no window to compare with', () => {
    // Five Rolling Members over-subscribe the pool; five One-time ones, whose
    // dormant day/month fields carry the same numbers, must not.
    const oneTime = Array.from({ length: 5 }, () => ({
      ...DEFAULT_MEMBER_LIMITS,
      kind: 'oneTime' as const,
      grantedAt: '2026-09-12T10:00:00.000Z',
    }));
    expect(poolOverSubscription(oneTime, DEFAULT_MEMBERS_POOL)).toEqual([]);
    expect(poolOverSubscription([...oneTime, DEFAULT_MEMBER_LIMITS], DEFAULT_MEMBERS_POOL)).toEqual(
      [],
    );
  });
});

// A Member's budget has exactly one kind: Rolling
// is the day + calendar-month shape, One-time a single total counted since its
// Grant. A row without a kind reads as Rolling — the only backfill allowed.
describe('member budget kind', () => {
  const grantedAt = '2026-09-12T10:00:00.000Z';

  it('parses a missing kind as rolling, so every stored row stays valid', () => {
    const { kind: _kind, ...legacy } = DEFAULT_MEMBER_LIMITS;
    const parsed = memberLimitsSchema.parse(legacy);
    expect(parsed.kind).toBe('rolling');
    expect(parsed).toEqual(DEFAULT_MEMBER_LIMITS);
  });

  it('accepts a One-time budget with totals and a Grant', () => {
    const parsed = memberLimitsSchema.parse({
      ...DEFAULT_MEMBER_LIMITS,
      kind: 'oneTime',
      totalGenerationTasks: 13,
      totalGeneratedCovers: 60,
      grantedAt,
    });
    expect(parsed.kind).toBe('oneTime');
    expect(parsed.grantedAt).toBe(grantedAt);
  });

  it('refuses a One-time budget without a Grant — used-since-nothing has no meaning', () => {
    expect(
      memberLimitsSchema.safeParse({ ...DEFAULT_MEMBER_LIMITS, kind: 'oneTime' }).success,
    ).toBe(false);
  });

  it('holds One-time totals to the same per-field ceilings as the monthly caps', () => {
    const oneTime = { ...DEFAULT_MEMBER_LIMITS, kind: 'oneTime', grantedAt };
    expect(
      memberLimitsSchema.safeParse({
        ...oneTime,
        totalGenerationTasks: USAGE_LIMIT_CEILINGS.monthlyGenerationTasks + 1,
      }).success,
    ).toBe(false);
    expect(
      memberLimitsSchema.safeParse({
        ...oneTime,
        totalGeneratedCovers: USAGE_LIMIT_CEILINGS.generatedCoversPerMonth + 1,
      }).success,
    ).toBe(false);
    expect(
      memberLimitsSchema.safeParse({
        ...oneTime,
        totalGenerationTasks: USAGE_LIMIT_CEILINGS.monthlyGenerationTasks,
        totalGeneratedCovers: USAGE_LIMIT_CEILINGS.generatedCoversPerMonth,
      }).success,
    ).toBe(true);
  });

  it('applies the monthly-at-least-daily rule to rolling only — a One-time budget has no day cap', () => {
    const shadowed = {
      ...DEFAULT_MEMBER_LIMITS,
      dailyGenerationTasks: 10,
      monthlyGenerationTasks: 9,
    };
    expect(memberLimitsSchema.safeParse({ ...shadowed, kind: 'rolling' }).success).toBe(false);
    expect(memberLimitsSchema.safeParse({ ...shadowed, kind: 'oneTime', grantedAt }).success).toBe(
      true,
    );
  });

  it('never accepts a Grant from a patch request — the server stamps it', () => {
    expect(updateMemberLimitsRequestSchema.safeParse({ kind: 'oneTime' }).success).toBe(true);
    expect(updateMemberLimitsRequestSchema.safeParse({ grantedAt }).success).toBe(false);
  });

  it('names the fields a patch carries that belong to the other kind', () => {
    expect(foreignKindFields('oneTime', { totalGenerationTasks: 5, maxQueuedTracks: 4 })).toEqual(
      [],
    );
    expect(
      foreignKindFields('oneTime', { dailyGenerationTasks: 5, generatedCoversPerMonth: 9 }),
    ).toEqual(['dailyGenerationTasks', 'generatedCoversPerMonth']);
    expect(
      foreignKindFields('rolling', { totalGeneratedCovers: 9, dailyGenerationTasks: 5 }),
    ).toEqual(['totalGeneratedCovers']);
  });
});
