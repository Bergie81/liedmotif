// Cover-spend usage counted the one way every caller shares: the worker's
// admission check (authoritative) and the web status endpoint (advisory
// indicator). Live reservations and every possibly-paid attempt count
// immediately — the same conservative posture as admission.
//
// Covers carry their own budgets, shaped like the music ones and
// resolved by `budget-scopes`: the Admin is bounded by the instance `usageLimits`
// cover caps alone; a Member's attempt must fit BOTH their `MemberLimits` cover
// caps and the Members Pool's. Uploads and the placeholder never touch these
// counts — only generated covers are budgeted, whichever source painted them.

import {
  boundedOrNull,
  boundWindow,
  checkCostLimits,
  limitWindowStarts,
  remainingInBound,
  type BoundWindow,
  type BoundWindows,
  type CostBound,
  type CostLimitScope,
  type CostLimitWindow,
} from '@liedmotif/shared';
import { unionAll } from 'drizzle-orm/pg-core';
import {
  adminBudgetCaps,
  lockAndResolveBudgetScopes,
  mapScopes,
  mapScopesConcurrently,
  resolveBudgetScopes,
  spendWindows,
  type BudgetScope,
  type SpendWindow,
} from '../budget-scopes';
import { ownerScope, type SpendScope } from '../member-pool';
import type { UsageLimits } from '../schema';
import type { DbOrTx, Transaction } from '../transactions';
import {
  countLegacyGeneratedCoversInWindow,
  legacyGeneratedCoversByOwnerQuery,
} from './generated-repo';
import {
  countReservedOrPossiblyPaidCovers,
  reservedOrPossiblyPaidLedgerRowsByOwnerQuery,
} from './generation-ledger-repo';

/** The slice of a limits object cover counting needs — instance, Member or Pool. */
export interface CoverBudgetCaps {
  generatedCoversPerDay: number;
  generatedCoversPerMonth: number;
}

export interface CoverUsage {
  usedDay: number;
  usedMonth: number;
  /** `null` when the window is unbounded: the Admin with the Cover ceiling off. */
  limitDay: number | null;
  limitMonth: number | null;
}

/**
 * The advisory readout of the viewer's own cover bound. Shaped for a rolling
 * budget's two windows; a One-time budget has only its total, which stands in
 * for both, and `oneTime` says so.
 */
export interface OwnCoverUsage extends CoverUsage {
  oneTime: boolean;
}

interface CoverUsageArgs {
  scope: SpendScope;
  caps: CoverBudgetCaps;
  resetTimezone: string;
  now: Date;
  excludeGenerationId?: string;
}

interface CoverCountArgs {
  scope: SpendScope;
  since: Date;
  excludeGenerationId?: string;
  /**
   * Issue the two component counts concurrently. LOCK-FREE pool handles only —
   * never a lock transaction, where concurrent queries would lean on
   * node-postgres's deprecated implicit per-client queuing.
   */
  concurrently: boolean;
}

/**
 * Generated-cover spend in one scope since `since`: live reservations plus every
 * possibly-paid attempt, with the pre-ledger legacy covers folded in.
 * `excludeGenerationId` leaves one attempt out — its own admission must not
 * count itself.
 */
async function countCoversSince(db: DbOrTx, args: CoverCountArgs): Promise<number> {
  const ledger = () =>
    countReservedOrPossiblyPaidCovers(db, {
      scope: args.scope,
      since: args.since,
      excludeGenerationId: args.excludeGenerationId,
    });
  const legacy = () =>
    countLegacyGeneratedCoversInWindow(db, { scope: args.scope, since: args.since });
  if (args.concurrently) {
    const [ledgerCount, legacyCount] = await Promise.all([ledger(), legacy()]);
    return ledgerCount + legacyCount;
  }
  return (await ledger()) + (await legacy());
}

/**
 * Generated-cover spend in one scope since one instant — the display read for
 * a One-time budget, whose single window starts at its Grant. LOCK-FREE pool
 * handles only.
 */
export async function countCoverSpendSince(
  db: DbOrTx,
  args: { scope: SpendScope; since: Date },
): Promise<number> {
  return countCoversSince(db, { ...args, concurrently: true });
}

/**
 * Rolling generated-cover spend counted in one scope over the instance day and
 * month windows (the one reset path). Sequential on purpose — safe on a lock
 * transaction (one connection). Lock-free callers on a pool handle use
 * `getCoverUsageConcurrently`.
 */
export async function getCoverUsage(db: DbOrTx, args: CoverUsageArgs): Promise<CoverUsage> {
  const { dayStart, monthStart } = limitWindowStarts(args.now, args.resetTimezone);
  const count = (since: Date) => countCoversSince(db, { ...args, since, concurrently: false });
  return {
    usedDay: await count(dayStart),
    usedMonth: await count(monthStart),
    limitDay: boundedOrNull(args.caps.generatedCoversPerDay),
    limitMonth: boundedOrNull(args.caps.generatedCoversPerMonth),
  };
}

/** `getCoverUsage` with every count issued concurrently. LOCK-FREE pool handles only. */
export async function getCoverUsageConcurrently(
  db: DbOrTx,
  args: CoverUsageArgs,
): Promise<CoverUsage> {
  const { dayStart, monthStart } = limitWindowStarts(args.now, args.resetTimezone);
  const count = (since: Date) => countCoversSince(db, { ...args, since, concurrently: true });
  const [usedDay, usedMonth] = await Promise.all([count(dayStart), count(monthStart)]);
  return {
    usedDay,
    usedMonth,
    limitDay: boundedOrNull(args.caps.generatedCoversPerDay),
    limitMonth: boundedOrNull(args.caps.generatedCoversPerMonth),
  };
}

/**
 * The Admin's own cover usage against the instance caps, for the Admin-only
 * Settings surfaces: a switched-off Cover ceiling reads as no limit.
 * `concurrently` only on a LOCK-FREE pool handle; a lock transaction takes the
 * sequential read.
 */
export async function getAdminCoverUsage(
  db: DbOrTx,
  args: { ownerUserId: string; instanceLimits: UsageLimits; now: Date; concurrently: boolean },
): Promise<CoverUsage> {
  const usageArgs: CoverUsageArgs = {
    scope: ownerScope(args.ownerUserId),
    caps: adminBudgetCaps(args.instanceLimits),
    resetTimezone: args.instanceLimits.resetTimezone,
    now: args.now,
  };
  return args.concurrently
    ? getCoverUsageConcurrently(db, usageArgs)
    : getCoverUsage(db, usageArgs);
}

/**
 * One budget scope's cover spend as the bound `checkCostLimits` takes, counted
 * over the windows of its kind — day/month for a rolling budget, since the
 * Grant for a One-time one — so no caller branches on kind.
 */
async function countCoverBound(
  db: DbOrTx,
  scope: BudgetScope,
  args: { resetTimezone: string; now: Date; excludeGenerationId?: string; concurrently: boolean },
): Promise<CostBound> {
  const windows = spendWindows(
    scope.budget,
    limitWindowStarts(args.now, args.resetTimezone),
    'covers',
  );
  const count = async (window: SpendWindow): Promise<BoundWindow> => ({
    window: window.window,
    cap: window.cap,
    used: await countCoversSince(db, {
      scope: scope.spend,
      since: window.since,
      excludeGenerationId: args.excludeGenerationId,
      concurrently: args.concurrently,
    }),
  });
  const [first, ...rest] = windows;
  let counted: BoundWindows;
  if (args.concurrently) {
    counted = await Promise.all([count(first), ...rest.map(count)]);
  } else {
    const sequential: [BoundWindow, ...BoundWindow[]] = [await count(first)];
    for (const window of rest) sequential.push(await count(window));
    counted = sequential;
  }
  return { scope: scope.scope, windows: counted };
}

/** A counted bound as the readout the status endpoints carry. */
function coverUsageOf(windows: BoundWindows): OwnCoverUsage {
  const day = boundWindow(windows, 'day');
  const month = boundWindow(windows, 'month');
  return {
    usedDay: day.used,
    usedMonth: month.used,
    limitDay: boundedOrNull(day.cap),
    limitMonth: boundedOrNull(month.cap),
    oneTime: windows[0].window === 'total',
  };
}

/**
 * The whole instance's generated-cover spend in one window, per owner, in ONE
 * statement (ledger + legacy union). The null key is the deleted
 * accounts' surviving ledger rows (set-null owner), kept as one group so the
 * entries still sum to the instance's whole spend the Members Pool counts.
 * Owners with no counted attempt are absent (read a missing key as 0).
 */
export async function countCoverSpendByOwnerOrDeleted(
  db: DbOrTx,
  args: { since: Date },
): Promise<Map<string | null, number>> {
  const rows = await unionAll(
    reservedOrPossiblyPaidLedgerRowsByOwnerQuery(db, args.since),
    legacyGeneratedCoversByOwnerQuery(db, args.since),
  );
  const totals = new Map<string | null, number>();
  for (const row of rows) {
    totals.set(row.ownerUserId, (totals.get(row.ownerUserId) ?? 0) + row.value);
  }
  return totals;
}

/**
 * `countCoverSpendByOwnerOrDeleted` per existing account — the batched read
 * behind admin surfaces that show one row per Member. A deleted account's spend
 * has no such row, so it is left out.
 */
export async function countCoverSpendByOwner(
  db: DbOrTx,
  args: { since: Date },
): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  for (const [ownerUserId, value] of await countCoverSpendByOwnerOrDeleted(db, args)) {
    if (ownerUserId !== null) totals.set(ownerUserId, value);
  }
  return totals;
}

/** Whether one more generated cover is admitted, and what refused it if not. */
export type CoverAdmission =
  | { admitted: true }
  | { admitted: false; reason: 'account_disabled' }
  | { admitted: false; reason: 'budget'; window: CostLimitWindow; scope: CostLimitScope };

/** The admission verdict for a set of counted per-scope bounds — the tail the
 *  authoritative in-lock and the advisory lock-free decisions share. */
function coverAdmissionFromBounds(bounds: readonly [CostBound, ...CostBound[]]): CoverAdmission {
  const decision = checkCostLimits(bounds);
  return decision.withinLimits
    ? { admitted: true }
    : { admitted: false, reason: 'budget', window: decision.window, scope: decision.scope };
}

/**
 * The AUTHORITATIVE admission decision for one more generated cover. The caller
 * must already hold its owner-scoped cover-admission lock; a Member's admission
 * additionally takes the Pool lock (fixed order: owner lock first) and must fit
 * both bounds. A disabled owner is refused with its own reason — a mid-flight
 * disable is not a budget that will refill, and must never be reported as one.
 */
export async function coverAdmissionDecision(
  tx: Transaction,
  args: {
    ownerUserId: string;
    instanceLimits: UsageLimits;
    now: Date;
    excludeGenerationId?: string;
  },
): Promise<CoverAdmission> {
  const budget = await lockAndResolveBudgetScopes(tx, args);
  if (budget.disabled) return { admitted: false, reason: 'account_disabled' };

  const bounds = await mapScopes(budget.scopes, (scope) =>
    countCoverBound(tx, scope, {
      resetTimezone: args.instanceLimits.resetTimezone,
      now: args.now,
      excludeGenerationId: args.excludeGenerationId,
      concurrently: false,
    }),
  );
  return coverAdmissionFromBounds(bounds);
}

/**
 * ADVISORY, LOCK-FREE mirror of `coverAdmissionDecision`, for a fast-fail before
 * the paid LLM cover-text enhancement runs — a budget-exhausted tap must not burn
 * an unmetered LLM call. It reads the same scopes and windows
 * without the admission lock and never spends, so a race here only ever costs one
 * enhancement; `coverAdmissionDecision` under the lock stays authoritative.
 */
export async function advisoryCoverAdmission(
  db: DbOrTx,
  args: { ownerUserId: string; instanceLimits: UsageLimits; now: Date },
): Promise<CoverAdmission> {
  const budget = await resolveBudgetScopes(db, args);
  if (budget.disabled) return { admitted: false, reason: 'account_disabled' };
  const bounds = await mapScopesConcurrently(budget.scopes, (scope) =>
    countCoverBound(db, scope, {
      resetTimezone: args.instanceLimits.resetTimezone,
      now: args.now,
      concurrently: true,
    }),
  );
  return coverAdmissionFromBounds(bounds);
}

/**
 * The ADVISORY cover-usage readout (status endpoints, the budget pages): the
 * viewer's OWN numbers against their own caps — the first scope, which is the
 * instance budget for the Admin and the Member's personal one for a Member —
 * with `remaining` additionally tightened by every other bound, so the indicator
 * can never promise an attempt admission would refuse. Lock-free by design; the
 * worker's in-lock admission stays authoritative.
 */
export async function coverUsageView(
  db: DbOrTx,
  args: { ownerUserId: string; instanceLimits: UsageLimits; now: Date },
): Promise<{ usage: OwnCoverUsage; remaining: number | null }> {
  const budget = await resolveBudgetScopes(db, args);
  const bounds = await mapScopesConcurrently(budget.scopes, (scope) =>
    countCoverBound(db, scope, {
      resetTimezone: args.instanceLimits.resetTimezone,
      now: args.now,
      concurrently: true,
    }),
  );
  return {
    usage: coverUsageOf(bounds[0].windows),
    remaining: boundedOrNull(Math.min(...bounds.map((bound) => remainingInBound(bound.windows)))),
  };
}
