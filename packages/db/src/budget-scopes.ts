// Which budgets a paid request is held to, resolved from the requester's role in
// ONE place. The Admin is bounded by the instance `usageLimits` alone;
// a Member must fit BOTH their own `MemberLimits` and the shared `MembersPool`.
//
// Every money chokepoint — the music submit in the worker, the cover admission,
// the creation-time headroom gate, the advisory readouts — asks this module for
// its bounds and then counts whatever unit it cares about (tasks, covers,
// in-flight jobs) once per scope. The role branch therefore exists here and
// nowhere else, and a caller cannot accidentally hold a Member to one bound.
//
// A budget's KIND is resolved here too: a rolling scope is
// counted over the instance day/month windows, a One-time scope over everything
// since its Grant. The chokepoints never branch on kind — they ask this module
// to count, and get back the bound `checkCostLimits` takes.

import {
  limitWindowStarts,
  type BoundWindows,
  type CostBound,
  type CostLimitScope,
  type CostLimitWindow,
  type LimitWindowStarts,
  type MemberLimits,
  type MembersPool,
} from '@liedmotif/shared';
import { acquireMembersPoolLock, countSpendAndInFlightForScopes } from './generation/limits-repo';
import { ownerScope, POOL_SCOPE, type SpendScope } from './member-pool';
import {
  resolveUserProfile,
  type UserProfile,
  type UserRole,
} from './profile/resolve-user-profile';
import type { UsageLimits } from './schema';
import { getMemberLimits } from './settings/user-settings-repo';
import { getMembersPool } from './setup/settings';
import type { DbOrTx, Transaction } from './transactions';

/**
 * The window caps a rolling budget defines, whichever settings object stores
 * them. `UsageLimits`, `MemberLimits` and `MembersPool` all satisfy this
 * structurally.
 */
export interface BudgetCaps {
  dailyGenerationTasks: number;
  monthlyGenerationTasks: number;
  generatedCoversPerDay: number;
  generatedCoversPerMonth: number;
}

/**
 * How one scope's spend is bounded. Rolling: the day and calendar-month caps,
 * counted from the instance windows. One-time: a Tracks total (tasks) and a
 * Covers total, counted from the Grant — one window that never rolls over.
 */
export type ScopeBudget =
  | { kind: 'rolling'; caps: BudgetCaps }
  | {
      kind: 'oneTime';
      grantedAt: Date;
      totalGenerationTasks: number;
      totalGeneratedCovers: number;
    };

/** One budget: what a refusal calls it, its bound, and whose spend counts against it. */
export interface BudgetScope {
  scope: CostLimitScope;
  budget: ScopeBudget;
  spend: SpendScope;
  /** The concurrency cost control this scope carries, whatever its kind. */
  maxConcurrentJobs: number;
}

/**
 * The scopes a request is held to, in refusal-precedence order — a Member's own
 * budget before the Pool, so a refusal names the budget they themselves spent
 * rather than one they cannot influence. Non-empty by construction: every role
 * has at least one bound.
 */
export type BudgetScopes = readonly [BudgetScope, ...BudgetScope[]];

/** The requester's bounds, plus whether their account may spend at all. */
export interface ResolvedBudget {
  /**
   * The account is disabled. Enforcement paths must refuse outright — a
   * mid-flight disable must not spend — while advisory readouts ignore it and
   * still show the numbers.
   */
  disabled: boolean;
  /**
   * The role the scopes were resolved for, which also decides whose fix a
   * refusal may name: only the Admin can change instance settings.
   * A profile-less owner reads as the Admin, the path its bounds take.
   */
  role: UserRole;
  scopes: BudgetScopes;
  /**
   * The queue-depth cost control that bounds this requester: the instance
   * `usageLimits` value for the Admin, the Member's own for a Member. It sits
   * outside `scopes` because the Pool states no queue depth — a shared budget
   * bounds spend windows and concurrency, never one session's buffer.
   */
  maxQueuedTracks: number;
}

/**
 * Resolve the requester's budget scopes. Lock-free: for the advisory readouts and
 * the creation-time headroom gate. Enforcement paths that will spend must use
 * `lockAndResolveBudgetScopes` instead, so the Pool count they read cannot move
 * under them.
 */
export async function resolveBudgetScopes(
  db: DbOrTx,
  args: {
    ownerUserId: string;
    instanceLimits: UsageLimits;
    /**
     * A profile the caller already resolved this request (e.g. the web guard's
     * request-cached read) — `null` means "resolved, no row". Advisory callers
     * only; enforcement paths re-read under their lock via
     * `lockAndResolveBudgetScopes`.
     */
    knownProfile?: UserProfile | null;
  },
): Promise<ResolvedBudget> {
  const profile =
    args.knownProfile !== undefined
      ? args.knownProfile
      : await resolveUserProfile(db, args.ownerUserId);
  const disabled = profile?.disabledAt != null;
  if (profile?.role !== 'member') {
    return adminBudget(disabled, args.ownerUserId, args.instanceLimits);
  }
  const [memberLimits, pool] = await Promise.all([
    getMemberLimits(db, args.ownerUserId),
    getMembersPool(db),
  ]);
  return memberBudget(disabled, args.ownerUserId, memberLimits, pool);
}

/**
 * Resolve the requester's budget scopes for a path that is about to SPEND. A
 * Member's resolution additionally takes the Pool-wide advisory lock, because two
 * different Members hold different per-owner locks and would otherwise both read
 * "Pool = cap − 1" and both submit. The caller must already hold its own
 * per-owner lock: the order is owner lock first, THEN the Pool lock, never the
 * reverse (see `acquireMembersPoolLock`). The Admin is not Pool-bound and never
 * takes it.
 */
export async function lockAndResolveBudgetScopes(
  tx: Transaction,
  args: { ownerUserId: string; instanceLimits: UsageLimits },
): Promise<ResolvedBudget> {
  const profile = await resolveUserProfile(tx, args.ownerUserId);
  const disabled = profile?.disabledAt != null;
  if (profile?.role !== 'member') {
    return adminBudget(disabled, args.ownerUserId, args.instanceLimits);
  }
  await acquireMembersPoolLock(tx);
  const memberLimits = await getMemberLimits(tx, args.ownerUserId);
  const pool = await getMembersPool(tx);
  return memberBudget(disabled, args.ownerUserId, memberLimits, pool);
}

/**
 * Count something once per scope, preserving the non-empty shape so the result
 * drops straight into `checkCostLimits` / `evaluateCreationHeadroom` without a
 * cast or an "what if there are no bounds" branch. Sequential on purpose: the
 * enforcement callers run inside one lock transaction, which is one connection.
 */
export async function mapScopes<T>(
  scopes: BudgetScopes,
  count: (scope: BudgetScope) => Promise<T>,
): Promise<readonly [T, ...T[]]> {
  const [first, ...rest] = scopes;
  const results: [T, ...T[]] = [await count(first)];
  for (const scope of rest) results.push(await count(scope));
  return results;
}

/**
 * The concurrent twin of `mapScopes`, for LOCK-FREE advisory callers on a pool
 * handle. Never use it inside a lock transaction — that is one connection, and
 * concurrent queries there would lean on node-postgres's deprecated implicit
 * per-client queuing. Enforcement callers keep `mapScopes`.
 */
export async function mapScopesConcurrently<T>(
  scopes: BudgetScopes,
  count: (scope: BudgetScope) => Promise<T>,
): Promise<readonly [T, ...T[]]> {
  const [first, ...rest] = scopes;
  return Promise.all([count(first), ...rest.map((scope) => count(scope))]);
}

/** Project per-scope results, preserving the non-empty shape `mapScopes` produced. */
export function mapScopeResults<T, U>(
  results: readonly [T, ...T[]],
  project: (value: T, index: number) => U,
): readonly [U, ...U[]] {
  const [first, ...rest] = results;
  return [project(first, 0), ...rest.map((value, index) => project(value, index + 1))];
}

/** One window a scope's spend is counted in: from when, and against which cap. */
export interface SpendWindow {
  window: CostLimitWindow;
  since: Date;
  cap: number;
}

/**
 * The windows one scope's spend is counted in, in the order `checkCostLimits`
 * checks them: a rolling budget is [day, month] from the instance windows, a
 * One-time budget is [total] from its Grant. `unit` picks the caps — music
 * tasks or covers — since both budgets carry one of each.
 */
export function spendWindows(
  budget: ScopeBudget,
  starts: LimitWindowStarts,
  unit: 'tasks' | 'covers',
): readonly [SpendWindow, ...SpendWindow[]] {
  if (budget.kind === 'oneTime') {
    return [
      {
        window: 'total',
        since: budget.grantedAt,
        cap: unit === 'tasks' ? budget.totalGenerationTasks : budget.totalGeneratedCovers,
      },
    ];
  }
  const { caps } = budget;
  const [day, month] =
    unit === 'tasks'
      ? [caps.dailyGenerationTasks, caps.monthlyGenerationTasks]
      : [caps.generatedCoversPerDay, caps.generatedCoversPerMonth];
  return [
    { window: 'day', since: starts.dayStart, cap: day },
    { window: 'month', since: starts.monthStart, cap: month },
  ];
}

/** One scope's music spend, counted: its bound plus the concurrency numbers. */
export interface CountedTaskScope {
  bound: CostBound;
  inFlightTasks: number;
  maxConcurrentJobs: number;
}

/**
 * Count every scope's music spend and in-flight jobs in ONE statement and pair
 * each with its caps — the read behind the submit chokepoint and the creation
 * headroom gate. Pairing happens here rather than at each chokepoint, so no
 * call site can measure one scope's spend against another's cap, and no call
 * site needs to know which kind of budget it is holding.
 */
export async function countTaskBounds(
  db: DbOrTx,
  args: {
    scopes: BudgetScopes;
    now: Date;
    resetTimezone: string;
    phantomSubmitCutoff: Date;
  },
): Promise<readonly [CountedTaskScope, ...CountedTaskScope[]]> {
  const starts = limitWindowStarts(args.now, args.resetTimezone);
  const windows = mapScopeResults(args.scopes, (scope) =>
    spendWindows(scope.budget, starts, 'tasks'),
  );
  const counts = await countSpendAndInFlightForScopes(db, {
    scopes: windows.map((scopeWindows, index) => ({
      spend: args.scopes[index]!.spend,
      since: scopeWindows.map((window) => window.since),
    })),
    phantomSubmitCutoff: args.phantomSubmitCutoff,
  });
  // `counts` aligns with `args.scopes` by index and each `tasksUsed` with its
  // `since` list (the function's contract); this zip is the only place that
  // alignment is consumed.
  return mapScopeResults(args.scopes, (scope, index) => {
    const counted = counts[index]!;
    const bounded: BoundWindows = mapScopeResults(windows[index]!, (window, position) => ({
      window: window.window,
      cap: window.cap,
      used: counted.tasksUsed[position] ?? 0,
    }));
    return {
      bound: { scope: scope.scope, windows: bounded },
      inFlightTasks: counted.inFlightTasks,
      maxConcurrentJobs: scope.maxConcurrentJobs,
    };
  });
}

/**
 * The Admin's window caps. A switched-off ceiling (`trackCeilingEnabled`,
 * `coverCeilingEnabled`) leaves its windows unbounded — an infinite cap that no
 * count reaches, so every chokepoint admits without a branch of its own. Readouts
 * show an infinite cap as no limit at all.
 */
export function adminBudgetCaps(instanceLimits: UsageLimits): BudgetCaps {
  const unbounded = Number.POSITIVE_INFINITY;
  return {
    dailyGenerationTasks: instanceLimits.trackCeilingEnabled
      ? instanceLimits.dailyGenerationTasks
      : unbounded,
    monthlyGenerationTasks: instanceLimits.trackCeilingEnabled
      ? instanceLimits.monthlyGenerationTasks
      : unbounded,
    generatedCoversPerDay: instanceLimits.coverCeilingEnabled
      ? instanceLimits.generatedCoversPerDay
      : unbounded,
    generatedCoversPerMonth: instanceLimits.coverCeilingEnabled
      ? instanceLimits.generatedCoversPerMonth
      : unbounded,
  };
}

function adminBudget(
  disabled: boolean,
  ownerUserId: string,
  instanceLimits: UsageLimits,
): ResolvedBudget {
  return {
    disabled,
    role: 'admin',
    scopes: [
      {
        scope: 'instance',
        budget: { kind: 'rolling', caps: adminBudgetCaps(instanceLimits) },
        spend: ownerScope(ownerUserId),
        maxConcurrentJobs: instanceLimits.maxConcurrentJobs,
      },
    ],
    maxQueuedTracks: instanceLimits.maxQueuedTracks,
  };
}

/**
 * A Member's stored budget as the bound their own scope is held to. A One-time
 * row without a Grant (the contract refuses one, so only a hand-edited row)
 * counts from the epoch — every spend, the money-conservative reading.
 */
function memberScopeBudget(limits: MemberLimits): ScopeBudget {
  if (limits.kind === 'oneTime') {
    return {
      kind: 'oneTime',
      grantedAt: new Date(limits.grantedAt ?? 0),
      totalGenerationTasks: limits.totalGenerationTasks,
      totalGeneratedCovers: limits.totalGeneratedCovers,
    };
  }
  return { kind: 'rolling', caps: limits };
}

function memberBudget(
  disabled: boolean,
  ownerUserId: string,
  memberLimits: MemberLimits,
  pool: MembersPool,
): ResolvedBudget {
  return {
    disabled,
    role: 'member',
    scopes: [
      {
        scope: 'member',
        budget: memberScopeBudget(memberLimits),
        spend: ownerScope(ownerUserId),
        maxConcurrentJobs: memberLimits.maxConcurrentJobs,
      },
      {
        scope: 'pool',
        budget: { kind: 'rolling', caps: pool },
        spend: POOL_SCOPE,
        maxConcurrentJobs: pool.maxConcurrentJobs,
      },
    ],
    maxQueuedTracks: memberLimits.maxQueuedTracks,
  };
}
