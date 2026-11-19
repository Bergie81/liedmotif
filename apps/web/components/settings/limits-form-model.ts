import type { UsageLimits } from '@liedmotif/db';
import { formatBinaryBytes } from '@/lib/format-bytes';
import {
  inCovers,
  inTracks,
  limitRowMax,
  limitRowMin,
  parseTrackRow,
  parseWholeRow,
  sessionStartWarning,
  type LimitRowBound,
  type ParsedLimitRow,
} from '@/lib/budget/limit-row-bounds';
import {
  providerTasksToTracks,
  stepNonNegativeWholeValue,
  wholeLimitNumber,
} from '@/lib/budget/track-units';

const GIB = 1024 ** 3;

export interface LimitFormValues {
  /** The zone the daily and monthly windows roll over in. */
  resetTimezone: string;
  /** Whether the daily and monthly limits bind the Admin's own generation. */
  trackCeilingEnabled: boolean;
  dailyTracks: string;
  monthlyTracks: string;
  concurrentTracks: string;
  maxQueuedTracks: string;
  idleAutoStopAfterMinutes: string;
  minHeadroomTracksToStartSession: string;
  storageQuotaBytes: string;
  generatedCoversPerDay: string;
  generatedCoversPerMonth: string;
  manualGenerationOnly: boolean;
  tailoredCoverArtEnabled: boolean;
  /** Whether the two Cover limits bind the Admin's own generation. */
  coverCeilingEnabled: boolean;
}

export type LimitFormField = keyof Pick<
  LimitFormValues,
  | 'dailyTracks'
  | 'monthlyTracks'
  | 'concurrentTracks'
  | 'maxQueuedTracks'
  | 'idleAutoStopAfterMinutes'
  | 'minHeadroomTracksToStartSession'
  | 'storageQuotaBytes'
  | 'generatedCoversPerDay'
  | 'generatedCoversPerMonth'
>;

export type LimitFieldErrors = Partial<Record<LimitFormField, string>>;
export type LimitFieldWarnings = Partial<Record<'dailyTracks' | 'monthlyTracks', string>>;

export function createLimitFormValues(
  initial: UsageLimits,
  tracksPerRequest: number,
): LimitFormValues {
  return {
    resetTimezone: initial.resetTimezone,
    trackCeilingEnabled: initial.trackCeilingEnabled,
    dailyTracks: String(providerTasksToTracks(initial.dailyGenerationTasks, tracksPerRequest)),
    monthlyTracks: String(providerTasksToTracks(initial.monthlyGenerationTasks, tracksPerRequest)),
    concurrentTracks: String(providerTasksToTracks(initial.maxConcurrentJobs, tracksPerRequest)),
    maxQueuedTracks: String(initial.maxQueuedTracks),
    idleAutoStopAfterMinutes: String(initial.idleAutoStopAfterMinutes),
    minHeadroomTracksToStartSession: String(initial.minHeadroomTracksToStartSession),
    storageQuotaBytes: String(initial.storageQuotaBytes),
    generatedCoversPerDay: String(initial.generatedCoversPerDay),
    generatedCoversPerMonth: String(initial.generatedCoversPerMonth),
    manualGenerationOnly: initial.manualGenerationOnly,
    tailoredCoverArtEnabled: initial.tailoredCoverArtEnabled,
    coverCeilingEnabled: initial.coverCeilingEnabled,
  };
}

/** What each editable row is bounded by and shown in. */
const LIMIT_ROWS: Record<LimitFormField, LimitRowBound> = {
  dailyTracks: { ceiling: 'dailyGenerationTasks', countedInTasks: true, label: inTracks },
  monthlyTracks: { ceiling: 'monthlyGenerationTasks', countedInTasks: true, label: inTracks },
  concurrentTracks: { ceiling: 'maxConcurrentJobs', countedInTasks: true, label: inTracks },
  maxQueuedTracks: { ceiling: 'maxQueuedTracks', label: inTracks },
  minHeadroomTracksToStartSession: {
    ceiling: 'minHeadroomTracksToStartSession',
    label: inTracks,
  },
  idleAutoStopAfterMinutes: {
    ceiling: 'idleAutoStopAfterMinutes',
    label: (max) => `${max} minutes`,
  },
  storageQuotaBytes: { ceiling: 'storageQuotaBytes', label: formatBinaryBytes },
  generatedCoversPerDay: { ceiling: 'generatedCoversPerDay', label: inCovers },
  generatedCoversPerMonth: { ceiling: 'generatedCoversPerMonth', label: inCovers },
};

/** A field's ceiling in the unit its row shows — what bounds its stepper. */
export function limitFieldMax(field: LimitFormField, tracksPerRequest: number): number {
  return limitRowMax(LIMIT_ROWS[field], tracksPerRequest);
}

/** A field's smallest accepted figure in the unit its row shows — the floor of its stepper. */
export function limitFieldMin(field: LimitFormField, tracksPerRequest: number): number {
  return limitRowMin(LIMIT_ROWS[field], tracksPerRequest);
}

/** One parsed row's stored figure, recording its message against the field. */
function take(field: LimitFormField, parsed: ParsedLimitRow, errors: LimitFieldErrors) {
  if ('error' in parsed) {
    errors[field] = parsed.error;
    return null;
  }
  return parsed.value;
}

/**
 * A cap whose ceiling switch is off: shown disabled, and neither validated nor
 * written, so the stored figure is still there when the switch comes back on.
 */
export function limitFieldSwitchedOff(field: LimitFormField, values: LimitFormValues): boolean {
  switch (field) {
    case 'dailyTracks':
    case 'monthlyTracks':
      return !values.trackCeilingEnabled;
    case 'generatedCoversPerDay':
    case 'generatedCoversPerMonth':
      return !values.coverCeilingEnabled;
    default:
      return false;
  }
}

/**
 * The Track caps set below "Headroom to start", read from the form so the
 * warning moves with either figure. A warning, never a refusal: the save goes
 * through as typed.
 */
export function limitFieldWarnings(values: LimitFormValues): LimitFieldWarnings {
  const warnings: LimitFieldWarnings = {};
  const headroom = wholeLimitNumber(values.minHeadroomTracksToStartSession);
  if (headroom === null) return warnings;
  for (const field of ['dailyTracks', 'monthlyTracks'] as const) {
    if (limitFieldSwitchedOff(field, values)) continue;
    const warning = sessionStartWarning(wholeLimitNumber(values[field]), headroom);
    if (warning) warnings[field] = warning;
  }
  return warnings;
}

/** Each editable row and the stored limit it writes. */
const PATCH_FIELDS = [
  ['dailyTracks', 'dailyGenerationTasks'],
  ['monthlyTracks', 'monthlyGenerationTasks'],
  ['concurrentTracks', 'maxConcurrentJobs'],
  ['maxQueuedTracks', 'maxQueuedTracks'],
  ['idleAutoStopAfterMinutes', 'idleAutoStopAfterMinutes'],
  ['minHeadroomTracksToStartSession', 'minHeadroomTracksToStartSession'],
  ['storageQuotaBytes', 'storageQuotaBytes'],
  ['generatedCoversPerDay', 'generatedCoversPerDay'],
  ['generatedCoversPerMonth', 'generatedCoversPerMonth'],
] as const satisfies readonly (readonly [LimitFormField, keyof UsageLimits])[];

export function buildLimitsPatch(
  values: LimitFormValues,
  tracksPerRequest: number,
): { ok: true; patch: Partial<UsageLimits> } | { ok: false; errors: LimitFieldErrors } {
  const errors: LimitFieldErrors = {};
  const patch: Partial<UsageLimits> = {
    resetTimezone: values.resetTimezone,
    trackCeilingEnabled: values.trackCeilingEnabled,
    manualGenerationOnly: values.manualGenerationOnly,
    tailoredCoverArtEnabled: values.tailoredCoverArtEnabled,
    coverCeilingEnabled: values.coverCeilingEnabled,
  };
  for (const [field, key] of PATCH_FIELDS) {
    if (limitFieldSwitchedOff(field, values)) continue;
    const row = LIMIT_ROWS[field];
    const parse = row.countedInTasks ? parseTrackRow : parseWholeRow;
    const parsed = take(field, parse(row, values[field], tracksPerRequest), errors);
    if (parsed !== null) patch[key] = parsed;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, patch };
}

export function stepLimitValue(value: string, amount: number, max: number, min = 0): string {
  return stepNonNegativeWholeValue(value, amount, max, min);
}

export function formatStorageQuota(bytes: string): string {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return '—';
  return formatBinaryBytes(value);
}

export const STORAGE_STEP_BYTES = GIB;
