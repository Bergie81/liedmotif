// The two spend ceilings onboarding sets, converted between what the owner sees
// and what `usageLimits` stores. Both screens patch the same object and the route
// takes partial patches, so each sends only the fields it owns and neither can
// clobber the other's.

import type { UsageLimits } from '@liedmotif/db';
import { usageLimitFloor } from '@liedmotif/shared';
import {
  normalizeTracksPerRequest,
  providerTasksToTracks,
  roundUpToWholeCalls,
  stepNonNegativeWholeValue,
  trackLimitToTasks,
  wholeLimitNumber,
} from '@/lib/budget/track-units';

/** The Track ceiling as the wizard holds it: whole Tracks, as strings. */
export interface TrackCeiling {
  /** Whether the day and month caps bind the Admin at all. */
  enabled: boolean;
  dailyTracks: string;
  monthlyTracks: string;
  concurrentTracks: string;
}

/** The Cover budget as the wizard holds it. Covers count one for one. */
export interface CoverBudget {
  tailoredCoverArtEnabled: boolean;
  /** Whether the day and month Cover caps bind the Admin at all. */
  ceilingEnabled: boolean;
  coversPerDay: string;
  coversPerMonth: string;
}

export type LimitPatch = { ok: true; patch: Partial<UsageLimits> } | { ok: false; error: string };

/**
 * The highest concurrency onboarding offers — a spend throttle, not a target (the
 * provider itself allows far more). Rounded DOWN to a whole number of provider
 * calls, so the stepper can never reach a figure the patch would reject.
 */
const CONCURRENT_TRACK_LIMIT = 10;

export function maxConcurrentTracks(tracksPerRequest: number): number {
  const yieldPerRequest = normalizeTracksPerRequest(tracksPerRequest);
  return Math.max(
    yieldPerRequest,
    Math.floor(CONCURRENT_TRACK_LIMIT / yieldPerRequest) * yieldPerRequest,
  );
}

/**
 * The lowest day or month cap the wizard offers: the Session-start headroom
 * rounded up to whole provider calls, since a window whose whole cap is below
 * the headroom never lets a new Session start. A headroom of 0 turns that gate
 * off, leaving one provider call.
 */
export function trackCapFloor(minHeadroomTracks: number, tracksPerRequest: number): number {
  const yieldPerRequest = normalizeTracksPerRequest(tracksPerRequest);
  return Math.max(yieldPerRequest, roundUpToWholeCalls(minHeadroomTracks, yieldPerRequest));
}

/**
 * Switch the day and month caps on or off. Switching on lifts a stored cap
 * below `floor` to it, so turning the limit on can never leave one that blocks
 * every new Session.
 */
export function switchTrackCeiling(
  ceiling: TrackCeiling,
  enabled: boolean,
  floor: number,
): TrackCeiling {
  if (!enabled) return { ...ceiling, enabled };
  const lifted = (value: string) => {
    const tracks = Number(value);
    return Number.isFinite(tracks) && tracks < floor ? String(floor) : value;
  };
  return {
    ...ceiling,
    enabled,
    dailyTracks: lifted(ceiling.dailyTracks),
    monthlyTracks: lifted(ceiling.monthlyTracks),
  };
}

/** The cap that runs out first: the month when it is set below the day. */
export function bindingTrackCap(ceiling: TrackCeiling): {
  tracks: number;
  window: 'day' | 'month';
} {
  const daily = Number(ceiling.dailyTracks);
  const monthly = Number(ceiling.monthlyTracks);
  return monthly < daily ? { tracks: monthly, window: 'month' } : { tracks: daily, window: 'day' };
}

/** Step a ceiling, keeping it inside the bounds its screen advertises. */
export function stepLimit(
  value: string,
  amount: number,
  bounds: { min?: number; max?: number } = {},
): string {
  const stepped = Number(stepNonNegativeWholeValue(value, amount));
  const floored = Math.max(stepped, bounds.min ?? 0);
  return String(bounds.max === undefined ? floored : Math.min(floored, bounds.max));
}

export function trackCeilingFromLimits(
  limits: UsageLimits,
  tracksPerRequest: number,
): TrackCeiling {
  return {
    enabled: limits.trackCeilingEnabled,
    dailyTracks: String(providerTasksToTracks(limits.dailyGenerationTasks, tracksPerRequest)),
    monthlyTracks: String(providerTasksToTracks(limits.monthlyGenerationTasks, tracksPerRequest)),
    concurrentTracks: String(providerTasksToTracks(limits.maxConcurrentJobs, tracksPerRequest)),
  };
}

export function coverBudgetFromLimits(limits: UsageLimits): CoverBudget {
  return {
    tailoredCoverArtEnabled: limits.tailoredCoverArtEnabled,
    ceilingEnabled: limits.coverCeilingEnabled,
    coversPerDay: String(limits.generatedCoversPerDay),
    coversPerMonth: String(limits.generatedCoversPerMonth),
  };
}

export function trackCeilingPatch(ceiling: TrackCeiling, tracksPerRequest: number): LimitPatch {
  const fields = [
    ['dailyGenerationTasks', ceiling.dailyTracks],
    ['monthlyGenerationTasks', ceiling.monthlyTracks],
    ['maxConcurrentJobs', ceiling.concurrentTracks],
  ] as const;
  const patch: Partial<UsageLimits> = { trackCeilingEnabled: ceiling.enabled };
  for (const [key, raw] of fields) {
    // Switched off, the day and month caps are not being set, so they are neither
    // validated nor written; the stored values come back if the switch is turned on later.
    if (!ceiling.enabled && key !== 'maxConcurrentJobs') continue;
    const parsed = trackLimitToTasks(raw, tracksPerRequest, usageLimitFloor(key));
    if ('error' in parsed) return { ok: false, error: parsed.error };
    patch[key] = parsed.tasks;
  }
  return { ok: true, patch };
}

export function coverBudgetPatch(budget: CoverBudget): LimitPatch {
  const switches = {
    tailoredCoverArtEnabled: budget.tailoredCoverArtEnabled,
    coverCeilingEnabled: budget.ceilingEnabled,
  };
  // Switched off, the caps are not being set: neither validated nor written.
  if (!budget.ceilingEnabled) return { ok: true, patch: switches };
  const perDay = wholeLimitNumber(budget.coversPerDay);
  const perMonth = wholeLimitNumber(budget.coversPerMonth);
  if (perDay === null || perMonth === null) {
    return { ok: false, error: 'Enter a whole number of covers (0 or more).' };
  }
  return {
    ok: true,
    patch: {
      ...switches,
      generatedCoversPerDay: perDay,
      generatedCoversPerMonth: perMonth,
    },
  };
}
