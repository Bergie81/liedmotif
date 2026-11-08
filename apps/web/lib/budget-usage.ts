// One scope's spend, read for DISPLAY (Settings → My budget, Settings → Members).
// Deliberately the same counting functions enforcement uses, so a readout can
// never disagree with a refusal — and one function, so a caps object and a used
// count can never be paired by hand into the wrong row.

import {
  countCoverSpendByOwner,
  countCoverSpendSince,
  countTasksInWindow,
  countTasksInWindowByOwner,
  getCoverUsageConcurrently,
  type Database,
  type SpendScope,
} from '@liedmotif/db';
import { limitWindowStarts } from '@liedmotif/shared';
import type { BudgetWindowCaps, BudgetWindowUsed, OneTimeBudgetUsed } from '@/lib/my-budget-model';

/** A One-time budget's spend: everything in the scope since its Grant. */
export async function readOneTimeBudgetUsed(
  db: Database,
  args: { scope: SpendScope; grantedAt: Date },
): Promise<OneTimeBudgetUsed> {
  const [tasks, covers] = await Promise.all([
    countTasksInWindow(db, { scope: args.scope, since: args.grantedAt }),
    countCoverSpendSince(db, { scope: args.scope, since: args.grantedAt }),
  ]);
  return { tasks, covers };
}

export async function readBudgetUsed(
  db: Database,
  args: { scope: SpendScope; caps: BudgetWindowCaps; resetTimezone: string; now: Date },
): Promise<BudgetWindowUsed> {
  const { dayStart, monthStart } = limitWindowStarts(args.now, args.resetTimezone);
  const [dailyTasks, monthlyTasks, covers] = await Promise.all([
    countTasksInWindow(db, { scope: args.scope, since: dayStart }),
    countTasksInWindow(db, { scope: args.scope, since: monthStart }),
    getCoverUsageConcurrently(db, {
      scope: args.scope,
      caps: args.caps,
      resetTimezone: args.resetTimezone,
      now: args.now,
    }),
  ]);
  return { dailyTasks, monthlyTasks, coversDay: covers.usedDay, coversMonth: covers.usedMonth };
}

/**
 * `readBudgetUsed` for EVERY owner at once — four batched statements instead of
 * one set per member. Same counting predicates, grouped by owner; an owner
 * absent from the map has spent nothing this window.
 */
export async function readBudgetUsedByOwner(
  db: Database,
  args: { resetTimezone: string; now: Date },
): Promise<(ownerUserId: string) => BudgetWindowUsed> {
  const { dayStart, monthStart } = limitWindowStarts(args.now, args.resetTimezone);
  const [dailyTasks, monthlyTasks, coversDay, coversMonth] = await Promise.all([
    countTasksInWindowByOwner(db, { since: dayStart }),
    countTasksInWindowByOwner(db, { since: monthStart }),
    countCoverSpendByOwner(db, { since: dayStart }),
    countCoverSpendByOwner(db, { since: monthStart }),
  ]);
  return (ownerUserId) => ({
    dailyTasks: dailyTasks.get(ownerUserId) ?? 0,
    monthlyTasks: monthlyTasks.get(ownerUserId) ?? 0,
    coversDay: coversDay.get(ownerUserId) ?? 0,
    coversMonth: coversMonth.get(ownerUserId) ?? 0,
  });
}
