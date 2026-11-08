// The pure shapes behind Settings → Members: the budget form in
// display units (Tracks/Covers — tasks never reach the Admin's eyes), the
// aggregate meta line, the over-subscription warning copy, and why a Member
// reset came back as a link to copy.

import {
  DEFAULT_MEMBER_LIMITS,
  estimatedCostUsd,
  unitCostsSet,
  type BudgetKind,
  type CostCounts,
  type MemberLimits,
  type MemberResetFallbackReason,
  type PoolOverSubscription,
  type UnitCosts,
} from '@liedmotif/shared';
import { formatBinaryBytes } from '@/lib/format-bytes';
import {
  inCovers,
  inTracks,
  limitRowMax,
  parseTrackRow,
  parseWholeRow,
  type LimitRowBound,
} from '@/lib/limit-row-bounds';
import type { BudgetUsage, BudgetWindowCaps, OneTimeBudgetTotals } from '@/lib/my-budget-model';
import { providerTasksToTracks, roundUpToWholeCalls, wholeLimitNumber } from '@/lib/track-units';

/**
 * Every budget field as typed, in Tracks and Covers: the four Rolling windows
 * and the two One-time totals. All six are always held, so a kind switch in
 * the form keeps the other kind's numbers for a switch back, like the stored
 * object does.
 */
export interface MemberBudgetFormValues {
  dailyTracks: string;
  monthlyTracks: string;
  coversPerDay: string;
  coversPerMonth: string;
  totalTracks: string;
  totalCovers: string;
}

export type MemberBudgetField = keyof MemberBudgetFormValues;
export type MemberBudgetErrors = Partial<Record<MemberBudgetField, string>>;

/** The kinds in the order the switch offers them: One-time first. */
export const BUDGET_KIND_ORDER: readonly BudgetKind[] = ['oneTime', 'rolling'];

const BUDGET_KIND_LABELS: Record<BudgetKind, string> = {
  oneTime: 'One-time',
  rolling: 'Rolling',
};

export function budgetKindLabel(kind: BudgetKind): string {
  return BUDGET_KIND_LABELS[kind];
}

/**
 * Where a new Invite's One-time totals start: the shipped defaults in the units
 * the Admin types. A task count converted to Tracks is always a whole number of
 * provider calls, so the rounding every typed total gets leaves the seed alone
 * and the field agrees with the priced readout beneath it.
 */
export function newInviteTotals(
  tracksPerCall: number,
): Pick<MemberBudgetFormValues, 'totalTracks' | 'totalCovers'> {
  return {
    totalTracks: String(
      providerTasksToTracks(DEFAULT_MEMBER_LIMITS.totalGenerationTasks, tracksPerCall),
    ),
    totalCovers: String(DEFAULT_MEMBER_LIMITS.totalGeneratedCovers),
  };
}

/** The Pool has no totals; its form carries the shipped One-time defaults, unread. */
export function memberBudgetFormValues(
  budget: BudgetWindowCaps & Partial<OneTimeBudgetTotals>,
  tracksPerCall: number,
): MemberBudgetFormValues {
  const totalTasks = budget.totalGenerationTasks ?? DEFAULT_MEMBER_LIMITS.totalGenerationTasks;
  return {
    dailyTracks: String(providerTasksToTracks(budget.dailyGenerationTasks, tracksPerCall)),
    monthlyTracks: String(providerTasksToTracks(budget.monthlyGenerationTasks, tracksPerCall)),
    coversPerDay: String(budget.generatedCoversPerDay),
    coversPerMonth: String(budget.generatedCoversPerMonth),
    totalTracks: String(providerTasksToTracks(totalTasks, tracksPerCall)),
    totalCovers: String(budget.totalGeneratedCovers ?? DEFAULT_MEMBER_LIMITS.totalGeneratedCovers),
  };
}

/** What each budget row is bounded by and shown in. */
const BUDGET_ROWS: Record<MemberBudgetField, LimitRowBound> = {
  dailyTracks: { ceiling: 'dailyGenerationTasks', countedInTasks: true, label: inTracks },
  monthlyTracks: { ceiling: 'monthlyGenerationTasks', countedInTasks: true, label: inTracks },
  coversPerDay: { ceiling: 'generatedCoversPerDay', label: inCovers },
  coversPerMonth: { ceiling: 'generatedCoversPerMonth', label: inCovers },
  totalTracks: { ceiling: 'monthlyGenerationTasks', countedInTasks: true, label: inTracks },
  totalCovers: { ceiling: 'generatedCoversPerMonth', label: inCovers },
};

/** A budget field's ceiling in the unit its row shows — what bounds its stepper. */
export function memberBudgetFieldMax(field: MemberBudgetField, tracksPerCall: number): number {
  return limitRowMax(BUDGET_ROWS[field], tracksPerCall);
}

type MemberBudgetPatchResult =
  { ok: true; patch: Partial<MemberLimits> } | { ok: false; errors: MemberBudgetErrors };

function parseBudgetRow(
  field: MemberBudgetField,
  raw: string,
  tracksPerCall: number,
): { value: number } | { error: string } {
  const bound = BUDGET_ROWS[field];
  return bound.countedInTasks
    ? parseTrackRow(bound, raw, tracksPerCall)
    : parseWholeRow(bound, raw, tracksPerCall);
}

/**
 * The four windows back into a stored `MemberLimits` patch (tasks), or the
 * per-field messages. Concurrency and queue depth ride the stored defaults —
 * this form deliberately edits only what the budgets mean in money.
 */
export function buildMemberBudgetPatch(
  values: MemberBudgetFormValues,
  tracksPerCall: number,
): MemberBudgetPatchResult {
  const errors: MemberBudgetErrors = {};
  const row = (field: MemberBudgetField) => {
    const parsed = parseBudgetRow(field, values[field], tracksPerCall);
    if ('error' in parsed) {
      errors[field] = parsed.error;
      return null;
    }
    return parsed.value;
  };
  const daily = row('dailyTracks');
  const monthly = row('monthlyTracks');
  const coversPerDay = row('coversPerDay');
  const coversPerMonth = row('coversPerMonth');
  if (daily === null || monthly === null || coversPerDay === null || coversPerMonth === null) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    patch: {
      dailyGenerationTasks: daily,
      monthlyGenerationTasks: monthly,
      generatedCoversPerDay: coversPerDay,
      generatedCoversPerMonth: coversPerMonth,
    },
  };
}

/**
 * A Member budget patch for the chosen kind, carrying that kind's fields only —
 * the routes refuse the other kind's. A One-time Tracks total is "at least this
 * many", so it rounds UP to whole provider calls rather than refusing an odd
 * number the way a window does.
 */
export function buildMemberBudgetKindPatch(
  kind: BudgetKind,
  values: MemberBudgetFormValues,
  tracksPerCall: number,
): MemberBudgetPatchResult {
  if (kind === 'rolling') {
    const windows = buildMemberBudgetPatch(values, tracksPerCall);
    return windows.ok ? { ok: true, patch: { kind, ...windows.patch } } : windows;
  }
  const errors: MemberBudgetErrors = {};
  const typedTracks = wholeLimitNumber(values.totalTracks);
  const roundedTracks =
    typedTracks === null
      ? values.totalTracks
      : String(roundUpToWholeCalls(typedTracks, tracksPerCall));
  const tracks = parseBudgetRow('totalTracks', roundedTracks, tracksPerCall);
  const covers = parseBudgetRow('totalCovers', values.totalCovers, tracksPerCall);
  if ('error' in tracks) errors.totalTracks = tracks.error;
  if ('error' in covers) errors.totalCovers = covers.error;
  if ('error' in tracks || 'error' in covers) return { ok: false, errors };
  return {
    ok: true,
    patch: { kind, totalGenerationTasks: tracks.value, totalGeneratedCovers: covers.value },
  };
}

/** UTC-pinned short date, deterministic across server and client renders. */
export function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** The one aggregate line under a Member's name. */
export function memberMetaLine(member: {
  joinedAt: string;
  lastActiveAt: string | null;
  trackCount: number;
  storageBytes: number;
}): string {
  return [
    `Joined ${formatShortDate(member.joinedAt)}`,
    member.lastActiveAt ? `Active ${formatShortDate(member.lastActiveAt)}` : 'Never signed in',
    `${member.trackCount} ${member.trackCount === 1 ? 'Track' : 'Tracks'}`,
    formatBinaryBytes(member.storageBytes),
  ].join(' · ');
}

/** How each over-subscribable field is named and counted to a human. */
const OVERSUBSCRIPTION_COPY: Record<
  PoolOverSubscription['field'],
  { label: string; unit: 'Tracks' | 'Covers' }
> = {
  dailyGenerationTasks: { label: 'daily Track budgets', unit: 'Tracks' },
  monthlyGenerationTasks: { label: 'monthly Track budgets', unit: 'Tracks' },
  generatedCoversPerDay: { label: 'daily Cover budgets', unit: 'Covers' },
  generatedCoversPerMonth: { label: 'monthly Cover budgets', unit: 'Covers' },
};

/** One warning sentence, in Tracks/Covers. Over-subscription is allowed — first come, first served. */
export function overSubscriptionMessage(
  warning: PoolOverSubscription,
  tracksPerCall: number,
): string {
  const { label, unit } = OVERSUBSCRIPTION_COPY[warning.field];
  const display = (stored: number) =>
    unit === 'Tracks' ? providerTasksToTracks(stored, tracksPerCall) : stored;
  return `Members' ${label} add up to ${display(warning.membersTotal)} ${unit}; the shared pool allows ${display(warning.poolCap)}. That is fine — the pool is first come, first served.`;
}

/**
 * The line beside a Member reset's link to copy. While account email is off the
 * link to copy is the whole flow, so it says nothing.
 */
const RESET_FALLBACK_LINES: Record<MemberResetFallbackReason, string | null> = {
  email_off: null,
  unconfirmed: "This Member hasn't confirmed their email, so copy the link and send it yourself.",
  disabled: 'This account is disabled, so no mail went out. Copy the link and send it yourself.',
  send_failed: 'The reset mail could not be sent, so copy the link and send it yourself.',
};

export function resetFallbackLine(reason: MemberResetFallbackReason): string | null {
  return RESET_FALLBACK_LINES[reason];
}

// --- Estimated cost ----------------------------------------------------------
// Every function here answers "nothing to show" with null: an estimate exists
// only once a price is above 0.

/**
 * What the form's numbers would cost: the totals for One-time, the monthly
 * caps for Rolling. A One-time Tracks total is priced as the figure that will
 * be stored — rounded up to whole provider calls — so the estimate equals the
 * card's once saved. Null while the active budget cannot be saved; an estimate must not guess.
 */
export function formEstimateCounts(
  kind: BudgetKind,
  values: MemberBudgetFormValues,
  tracksPerCall: number,
): CostCounts | null {
  const parsed = buildMemberBudgetKindPatch(kind, values, tracksPerCall);
  if (!parsed.ok) return null;
  const tasks =
    kind === 'oneTime' ? parsed.patch.totalGenerationTasks : parsed.patch.monthlyGenerationTasks;
  const covers =
    kind === 'oneTime' ? parsed.patch.totalGeneratedCovers : parsed.patch.generatedCoversPerMonth;
  if (tasks === undefined || covers === undefined) return null;
  return { tracks: providerTasksToTracks(tasks, tracksPerCall), covers };
}

function usageCounts(usage: BudgetUsage): { used: CostCounts; max: CostCounts; left: CostCounts } {
  if (usage.kind === 'oneTime') {
    return {
      used: { tracks: usage.tracks.used, covers: usage.covers.used },
      max: { tracks: usage.tracks.limit, covers: usage.covers.limit },
      left: { tracks: usage.tracks.remaining, covers: usage.covers.remaining },
    };
  }
  const { tracksMonth, coversMonth } = usage.figures;
  return {
    used: { tracks: tracksMonth.used, covers: coversMonth.used },
    max: { tracks: tracksMonth.limit, covers: coversMonth.limit },
    left: { tracks: tracksMonth.remaining, covers: coversMonth.remaining },
  };
}

export interface MembersCostSummary {
  /** Null while no claimed Member holds a Rolling budget. */
  rolling: { maxPerMonth: number; usedThisMonth: number } | null;
  /** Null while no claimed Member holds a One-time budget. */
  oneTime: { outstanding: number; used: number } | null;
}

/**
 * The page's two lines over claimed Members — the list handed in is already
 * exactly that (accounts, so Disabled included; an unclaimed Invite has no
 * account). Each line is one figure: Tracks and Covers fold together here. A
 * kind no Member holds has no line, and no Member at all means no summary:
 * a sum over nobody would read "$0".
 */
export function membersCostSummary(
  members: ReadonlyArray<{ usage: BudgetUsage }>,
  costs: UnitCosts,
): MembersCostSummary | null {
  if (!unitCostsSet(costs)) return null;
  let rolling: { maxPerMonth: number; usedThisMonth: number } | null = null;
  let oneTime: { outstanding: number; used: number } | null = null;
  for (const member of members) {
    const counts = usageCounts(member.usage);
    if (member.usage.kind === 'oneTime') {
      oneTime ??= { outstanding: 0, used: 0 };
      oneTime.outstanding += estimatedCostUsd(counts.left, costs);
      oneTime.used += estimatedCostUsd(counts.used, costs);
    } else {
      rolling ??= { maxPerMonth: 0, usedThisMonth: 0 };
      rolling.maxPerMonth += estimatedCostUsd(counts.max, costs);
      rolling.usedThisMonth += estimatedCostUsd(counts.used, costs);
    }
  }
  if (!rolling && !oneTime) return null;
  const cents = (amount: number) => Math.round(amount * 100) / 100;
  return {
    rolling: rolling && {
      maxPerMonth: cents(rolling.maxPerMonth),
      usedThisMonth: cents(rolling.usedThisMonth),
    },
    oneTime: oneTime && { outstanding: cents(oneTime.outstanding), used: cents(oneTime.used) },
  };
}
