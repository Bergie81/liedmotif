// One editable cost-limit row, parsed and bounded. The shared ceilings
// (`USAGE_LIMIT_CEILINGS`) are stored in the units the limits are counted in —
// provider TASKS for the generation windows — while every row shows Tracks or
// Covers, so a row that converts its value must convert its ceiling the same
// way, or its stepper stops at half the real limit and its refusal names a
// figure the admin never typed. Each form declares what its rows mean; the
// parsing and bounding live here once, for the admin instance limits and the
// Invite Mode Member/Pool budgets alike.

import {
  USAGE_LIMIT_CEILINGS,
  usageLimitFloor,
  type UsageLimitCeilingField,
} from '@liedmotif/shared';
import { providerTasksToTracks, trackLimitToTasks, wholeLimitNumber } from './track-units';

/** What one editable row is bounded by, and how that bound reads back. */
export interface LimitRowBound {
  /** The shared ceiling that bounds this row. */
  ceiling: UsageLimitCeilingField;
  /** True when the stored figure is a task count the row shows in Tracks. */
  countedInTasks?: boolean;
  /** Names the ceiling in the row's own unit. */
  label: (max: number) => string;
}

export const inTracks = (max: number): string => `${max} tracks`;
export const inCovers = (max: number): string => `${max} covers`;

/** A row's ceiling in the unit it shows — what bounds its stepper. */
export function limitRowMax(row: LimitRowBound, tracksPerRequest: number): number {
  const ceiling = USAGE_LIMIT_CEILINGS[row.ceiling];
  return row.countedInTasks ? providerTasksToTracks(ceiling, tracksPerRequest) : ceiling;
}

/** A row's smallest accepted figure in the unit it shows — what stops its stepper going lower. */
export function limitRowMin(row: LimitRowBound, tracksPerRequest: number): number {
  const floor = usageLimitFloor(row.ceiling);
  return row.countedInTasks ? providerTasksToTracks(floor, tracksPerRequest) : floor;
}

/**
 * The refusal for a figure above its row's ceiling, or null when it fits. The
 * route refuses the same values in stored keys and task units — a message no
 * one reading a Tracks row can act on.
 */
function ceilingRefusal(
  row: LimitRowBound,
  value: number,
  tracksPerRequest: number,
): string | null {
  const max = limitRowMax(row, tracksPerRequest);
  return value <= max ? null : `Enter at most ${row.label(max)}.`;
}

/** One row's figure as the stored limit, or the message to show against it. */
export type ParsedLimitRow = { value: number } | { error: string };

/** A Track-counted row: whole Tracks, divisible into calls, between the floor and the ceiling. */
export function parseTrackRow(
  row: LimitRowBound,
  raw: string,
  tracksPerRequest: number,
): ParsedLimitRow {
  const parsed = trackLimitToTasks(raw, tracksPerRequest, usageLimitFloor(row.ceiling));
  if ('error' in parsed) return parsed;
  const tracks = providerTasksToTracks(parsed.tasks, tracksPerRequest);
  const refusal = ceilingRefusal(row, tracks, tracksPerRequest);
  return refusal ? { error: refusal } : { value: parsed.tasks };
}

/** A row counted one for one (Covers, minutes, bytes, queue depth). */
export function parseWholeRow(
  row: LimitRowBound,
  raw: string,
  tracksPerRequest: number,
): ParsedLimitRow {
  const value = wholeLimitNumber(raw);
  if (value === null) return { error: 'Enter a whole number (0 or more).' };
  const min = limitRowMin(row, tracksPerRequest);
  if (value < min) return { error: `Enter ${min} or more.` };
  const refusal = ceilingRefusal(row, value, tracksPerRequest);
  return refusal ? { error: refusal } : { value };
}

/**
 * The warning for a Track cap too small for any new Session to start under, or
 * null. The creation gate wants `minHeadroomTracks` left in the window, which a
 * whole cap below it never has; this warns and never refuses. 0 is a deliberate
 * stop, not this mistake, and a headroom of 0 turns the gate off.
 */
export function sessionStartWarning(
  capTracks: number | null,
  minHeadroomTracks: number,
): string | null {
  if (capTracks === null || capTracks === 0 || capTracks >= minHeadroomTracks) return null;
  return `Below ${minHeadroomTracks} tracks, no new session can start.`;
}
