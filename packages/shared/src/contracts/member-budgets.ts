// Member budgets (Invite Mode): the per-Member `MemberLimits` object
// (stored in `user_settings` under the `limits` key) and the shared
// `MembersPool` ceiling over ALL Members (stored in `app_settings` under
// `memberPool`). Both are counted in provider TASKS internally and always
// shown to a human in Tracks — the existing convention. The Admin's own
// `usageLimits` stays untouched and outside the Pool; worst-case instance
// spend is `Admin caps + Pool caps`.
//
// There is deliberately no `resetTimezone` here: the Admin's
// `usageLimits.resetTimezone` owns the window rollover for the whole instance —
// two timezones would give two truths about when a budget refills.
//
// A Member's budget has exactly one KIND:
// `rolling` — the day + calendar-month caps — or `oneTime` — a Tracks total and
// a Covers total counted since the Grant (`grantedAt`), never renewing. The
// object is flat: every field is always stored, `kind` says which are live.
// Flat because the stored value is patched by shallow merge (`value || patch`),
// so switching kind is one field and the other kind's numbers stay put for a
// switch back. A row written before kinds existed carries no `kind` and reads as
// `rolling`.

import { z } from 'zod';
import {
  USAGE_LIMIT_CEILINGS,
  usageLimitFloor,
  type UsageLimitCeilingField,
} from './usage-limit-ceilings';

/**
 * One budget count: whole, at or above the field's floor, and under the same
 * instance ceiling the Admin's own limits carry. 0 means "none at all" wherever
 * the floor allows it; the ceiling is a typo guard, so every value an admin
 * could plausibly mean stays valid.
 */
function budgetCount(field: UsageLimitCeilingField) {
  return z.number().int().min(usageLimitFloor(field)).max(USAGE_LIMIT_CEILINGS[field]);
}

export const BUDGET_KINDS = ['rolling', 'oneTime'] as const;
export type BudgetKind = (typeof BUDGET_KINDS)[number];

/** The fields the window rules read; the Pool has no kind and is always rolling. */
interface WindowedBudget {
  kind?: BudgetKind;
  dailyGenerationTasks: number;
  monthlyGenerationTasks: number;
  generatedCoversPerDay: number;
  generatedCoversPerMonth: number;
}

/**
 * Refuse a monthly cap below the daily one — it would silently shadow it. Only
 * a rolling budget has windows; a One-time budget's day/month fields are dormant.
 */
function monthlyAtLeastDaily(
  daily: 'dailyGenerationTasks' | 'generatedCoversPerDay',
  monthly: 'monthlyGenerationTasks' | 'generatedCoversPerMonth',
) {
  return (value: WindowedBudget, ctx: z.RefinementCtx) => {
    if (value.kind === 'oneTime') return;
    if (value[monthly] < value[daily]) {
      ctx.addIssue({
        code: 'custom',
        message: `${monthly} must be at least ${daily}`,
        path: [monthly],
      });
    }
  };
}

/** Both budget objects carry the monthly-at-least-daily rule on both windows. */
function withWindowRefinements<T extends z.ZodType<WindowedBudget>>(schema: T) {
  return schema
    .superRefine(monthlyAtLeastDaily('dailyGenerationTasks', 'monthlyGenerationTasks'))
    .superRefine(monthlyAtLeastDaily('generatedCoversPerDay', 'generatedCoversPerMonth'));
}

/** The One-time totals a fresh budget starts from: 50 Tracks (25 calls at 2 per call), 25 Covers. */
const DEFAULT_ONE_TIME_TASKS = 25;
const DEFAULT_ONE_TIME_COVERS = 25;

const memberLimitsShape = {
  kind: z.enum(BUDGET_KINDS),
  dailyGenerationTasks: budgetCount('dailyGenerationTasks'),
  monthlyGenerationTasks: budgetCount('monthlyGenerationTasks'),
  maxConcurrentJobs: budgetCount('maxConcurrentJobs'),
  maxQueuedTracks: budgetCount('maxQueuedTracks'),
  generatedCoversPerDay: budgetCount('generatedCoversPerDay'),
  generatedCoversPerMonth: budgetCount('generatedCoversPerMonth'),
  /** One-time only: the Tracks total, in tasks; the monthly ceiling is its typo guard. */
  totalGenerationTasks: budgetCount('monthlyGenerationTasks'),
  /** One-time only: the Covers total. */
  totalGeneratedCovers: budgetCount('generatedCoversPerMonth'),
  /**
   * The Grant (ISO instant): when the kind was last chosen. A One-time budget
   * counts spend from here. Stamped by the server, never by a request.
   */
  grantedAt: z.iso.datetime().optional(),
};

export const memberLimitsSchema = withWindowRefinements(
  z.strictObject({
    ...memberLimitsShape,
    kind: memberLimitsShape.kind.default('rolling'),
    totalGenerationTasks: memberLimitsShape.totalGenerationTasks.default(DEFAULT_ONE_TIME_TASKS),
    totalGeneratedCovers: memberLimitsShape.totalGeneratedCovers.default(DEFAULT_ONE_TIME_COVERS),
  }),
).superRefine((value, ctx) => {
  if (value.kind === 'oneTime' && value.grantedAt === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'grantedAt is required for a One-time budget',
      path: ['grantedAt'],
    });
  }
});
export type MemberLimits = z.infer<typeof memberLimitsSchema>;

/** Rolling: 20 Tracks/day, 100/month (10/50 tasks at 2 tracks per call), 10/25 covers. */
export const DEFAULT_MEMBER_LIMITS: MemberLimits = {
  kind: 'rolling',
  dailyGenerationTasks: 10,
  monthlyGenerationTasks: 50,
  maxConcurrentJobs: 1,
  maxQueuedTracks: 6,
  generatedCoversPerDay: 10,
  generatedCoversPerMonth: 25,
  totalGenerationTasks: DEFAULT_ONE_TIME_TASKS,
  totalGeneratedCovers: DEFAULT_ONE_TIME_COVERS,
};

const membersPoolShape = {
  dailyGenerationTasks: budgetCount('dailyGenerationTasks'),
  monthlyGenerationTasks: budgetCount('monthlyGenerationTasks'),
  maxConcurrentJobs: budgetCount('maxConcurrentJobs'),
  generatedCoversPerDay: budgetCount('generatedCoversPerDay'),
  generatedCoversPerMonth: budgetCount('generatedCoversPerMonth'),
};

export const membersPoolSchema = withWindowRefinements(z.strictObject(membersPoolShape));
export type MembersPool = z.infer<typeof membersPoolSchema>;

/** 50 Tracks/day, 250/month (25/125 tasks), 25/125 covers, 2 jobs at once. */
export const DEFAULT_MEMBERS_POOL: MembersPool = {
  dailyGenerationTasks: 25,
  monthlyGenerationTasks: 125,
  maxConcurrentJobs: 2,
  generatedCoversPerDay: 25,
  generatedCoversPerMonth: 125,
};

/**
 * Update requests are partial patches; omitted fields keep their value. The
 * Grant is not patchable: the server stamps it when the kind changes.
 */
export const updateMemberLimitsRequestSchema = z
  .strictObject(memberLimitsShape)
  .omit({ grantedAt: true })
  .partial();
export type UpdateMemberLimitsRequest = z.infer<typeof updateMemberLimitsRequestSchema>;

/** The fields only one kind reads; the other kind's are dormant in storage. */
const ROLLING_ONLY_FIELDS = [
  'dailyGenerationTasks',
  'monthlyGenerationTasks',
  'generatedCoversPerDay',
  'generatedCoversPerMonth',
] as const;
const ONE_TIME_ONLY_FIELDS = ['totalGenerationTasks', 'totalGeneratedCovers'] as const;

/**
 * The fields in a patch that belong to the OTHER kind than the one the budget
 * lands on. A patch carrying them is a form bug, refused rather than stored
 * dormant where nothing would ever read it.
 */
export function foreignKindFields(kind: BudgetKind, patch: UpdateMemberLimitsRequest): string[] {
  const foreign: readonly string[] =
    kind === 'oneTime' ? ROLLING_ONLY_FIELDS : ONE_TIME_ONLY_FIELDS;
  return foreign.filter((field) => field in patch);
}

export const updateMembersPoolRequestSchema = z.strictObject(membersPoolShape).partial();
export type UpdateMembersPoolRequest = z.infer<typeof updateMembersPoolRequestSchema>;

/** The budget windows the Pool can be over-subscribed on (never concurrency —
 * Σ per-Member concurrency exceeding the Pool's is the normal, intended state). */
export const POOL_OVERSUBSCRIPTION_FIELDS = [
  'dailyGenerationTasks',
  'monthlyGenerationTasks',
  'generatedCoversPerDay',
  'generatedCoversPerMonth',
] as const;
export type PoolOverSubscriptionField = (typeof POOL_OVERSUBSCRIPTION_FIELDS)[number];

export interface PoolOverSubscription {
  field: PoolOverSubscriptionField;
  membersTotal: number;
  poolCap: number;
}

/**
 * Where Σ member budgets exceeds the Pool. Over-subscription is ALLOWED
 * (first-come, first-served inside the Pool) — this is a warning the UI shows,
 * never a refusal. Rolling Members only: a One-time total has no window to
 * compare with the Pool's, and its dormant day/month fields are not a budget.
 */
export function poolOverSubscription(
  memberLimits: readonly MemberLimits[],
  pool: MembersPool,
): PoolOverSubscription[] {
  const rolling = memberLimits.filter((limits) => limits.kind !== 'oneTime');
  return POOL_OVERSUBSCRIPTION_FIELDS.flatMap((field) => {
    const membersTotal = rolling.reduce((sum, limits) => sum + limits[field], 0);
    return membersTotal > pool[field] ? [{ field, membersTotal, poolCap: pool[field] }] : [];
  });
}

/** Admin toggles a Member's disabled state. */
export const setMemberDisabledRequestSchema = z.strictObject({ disabled: z.boolean() });
export type SetMemberDisabledRequest = z.infer<typeof setMemberDisabledRequestSchema>;
