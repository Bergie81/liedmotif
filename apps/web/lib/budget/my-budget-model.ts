// Settings → My budget: the pure presentation model of
// a Member's own usage and the shared Pool's. Everything a human sees is in
// Tracks and covers — a task count reaching this model's output is a bug; the
// conversion happens here, once, with the provider's tracks-per-call.

import { providerTasksToTracks } from '@/lib/budget/track-units';

/** One budget window as displayed: used / cap / remaining, never negative. */
export interface BudgetWindow {
  used: number;
  limit: number;
  remaining: number;
}

export interface BudgetFigures {
  tracksDay: BudgetWindow;
  tracksMonth: BudgetWindow;
  coversDay: BudgetWindow;
  coversMonth: BudgetWindow;
}

/**
 * One budget's usage, per its kind. Rolling: the four
 * windows. One-time: the two totals, counted since the Grant — no window, so
 * nothing here can be captioned with a reset date.
 */
export type BudgetUsage =
  { kind: 'rolling'; figures: BudgetFigures } | ({ kind: 'oneTime' } & OneTimeBudgetFigures);

/** The full page payload: the Member's own numbers and the Pool aggregate —
 * deliberately no per-member breakdown, no names, nothing attributable. */
export interface MyBudgetData {
  yours: BudgetUsage;
  /** The Pool is always a rolling budget, whatever the Member's own kind. */
  shared: BudgetFigures;
  /** The instance reset timezone, so "at midnight" is true for the instance. */
  resetTimezone: string;
}

function budgetWindow(used: number, limit: number): BudgetWindow {
  return { used, limit, remaining: Math.max(0, limit - used) };
}

/**
 * The four stored window caps a displayed budget is measured against —
 * `UsageLimits`, `MemberLimits` and `MembersPool` all satisfy it structurally.
 */
export interface BudgetWindowCaps {
  dailyGenerationTasks: number;
  monthlyGenerationTasks: number;
  generatedCoversPerDay: number;
  generatedCoversPerMonth: number;
}

/** What has been spent against those caps, each in the unit it is counted in. */
export interface BudgetWindowUsed {
  /** Music spend, in provider calls (tasks) — converted to Tracks for display. */
  dailyTasks: number;
  monthlyTasks: number;
  /** Cover spend, already in covers. */
  coversDay: number;
  coversMonth: number;
}

/**
 * One scope's displayed figures — also the Members administration's per-row unit.
 * Caps and counts arrive as separate arguments on purpose: they come from
 * different reads, and pairing them by hand at each call site is how a row ends
 * up showing one Member's usage against another's cap.
 */
export function budgetFigures(
  caps: BudgetWindowCaps,
  used: BudgetWindowUsed,
  tracksPerCall: number,
): BudgetFigures {
  const inTracks = (tasks: number) => providerTasksToTracks(tasks, tracksPerCall);
  return {
    tracksDay: budgetWindow(inTracks(used.dailyTasks), inTracks(caps.dailyGenerationTasks)),
    tracksMonth: budgetWindow(inTracks(used.monthlyTasks), inTracks(caps.monthlyGenerationTasks)),
    coversDay: budgetWindow(used.coversDay, caps.generatedCoversPerDay),
    coversMonth: budgetWindow(used.coversMonth, caps.generatedCoversPerMonth),
  };
}

/** A One-time budget's two totals, as stored (tasks / covers). */
export interface OneTimeBudgetTotals {
  totalGenerationTasks: number;
  totalGeneratedCovers: number;
}

/** What has been spent against those totals since the Grant. */
export interface OneTimeBudgetUsed {
  tasks: number;
  covers: number;
}

export interface OneTimeBudgetFigures {
  tracks: BudgetWindow;
  covers: BudgetWindow;
}

/** A One-time budget's displayed figures: one window each for Tracks and Covers. */
export function oneTimeBudgetFigures(
  totals: OneTimeBudgetTotals,
  used: OneTimeBudgetUsed,
  tracksPerCall: number,
): OneTimeBudgetFigures {
  const inTracks = (tasks: number) => providerTasksToTracks(tasks, tracksPerCall);
  return {
    tracks: budgetWindow(inTracks(used.tasks), inTracks(totals.totalGenerationTasks)),
    covers: budgetWindow(used.covers, totals.totalGeneratedCovers),
  };
}

/** One scope's caps and counted spend, in the shape its kind is counted in. */
export type BudgetUsageInput =
  | { kind: 'rolling'; caps: BudgetWindowCaps; used: BudgetWindowUsed }
  | { kind: 'oneTime'; totals: OneTimeBudgetTotals; used: OneTimeBudgetUsed };

export function budgetUsage(input: BudgetUsageInput, tracksPerCall: number): BudgetUsage {
  if (input.kind === 'oneTime') {
    return { kind: 'oneTime', ...oneTimeBudgetFigures(input.totals, input.used, tracksPerCall) };
  }
  return { kind: 'rolling', figures: budgetFigures(input.caps, input.used, tracksPerCall) };
}

export function buildMyBudgetData(input: {
  yours: BudgetUsageInput;
  shared: { caps: BudgetWindowCaps; used: BudgetWindowUsed };
  tracksPerCall: number;
  resetTimezone: string;
}): MyBudgetData {
  return {
    yours: budgetUsage(input.yours, input.tracksPerCall),
    shared: budgetFigures(input.shared.caps, input.shared.used, input.tracksPerCall),
    resetTimezone: input.resetTimezone,
  };
}
