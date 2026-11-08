// Blend-identity + analysis contracts.
//
// Two vocabularies live here, deliberately distinct:
//
// - The TRACK-side analysis provenance (`ANALYSIS_STATUSES`, `BPM_SOURCES`)
//   mirrors the `tracks` pgEnums.
//   `pending` means "not analyzed yet" and never reaches the queue contract.
// - The QUEUE-side `blendAnalysis.status` (`BLEND_ANALYSIS_STATUSES`) is the
//   client-facing subset: a `pending` track simply carries `blendAnalysis: null`,
//   and the DB's `measured` surfaces as `complete`.
//
// The numeric write bounds (`TRACK_ANALYSIS_BOUNDS`, `validateTrackAnalysis`)
// guard every analysis write: fake/measured values outside physical plausibility
// must never be persisted, because downstream edge policy trusts these numbers.

import { z } from 'zod';

/**
 * The analyzer version stamped on every analysis write. The queue route OMITS a
 * `blendAnalysis` whose stored version is below this (stale suppression), and
 * beat-locking additionally requires EQUAL versions on both decks —
 * the estimator's constant onset-detection bias only cancels across an edge when
 * both sides ran the same analyzer. Version 1 is the anchored estimator;
 * version 2 is the real analyzer (ffmpeg loudness + onset-autocorrelation
 * tempo), which supersedes every version-1 row (the backfill sweep re-analyzes
 * them).
 */
export const CURRENT_ANALYSIS_VERSION = 2;

/**
 * The estimator confidence a BPM measurement needs to count as `measured`
 * (fixed 2026-07-10 from a measured corpus). Below the floor
 * the analyzer falls back to the anchored estimate, and the edge policy
 * refuses beat-locking.
 */
export const BPM_CONFIDENCE_FLOOR = 0.75;

/** Track-side analysis provenance (mirrors the `analysis_status` pgEnum). */
export const ANALYSIS_STATUSES = [
  'pending',
  'measured',
  'partial',
  'unavailable',
  'failed',
] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

/** Where a track's BPM estimate came from (mirrors the `bpm_source` pgEnum).
 *  Only `measured` may ever activate beat-locking; `anchored` is derived from the
 *  generation-time target, not the audio. */
export const BPM_SOURCES = ['measured', 'anchored'] as const;
export type BpmSource = (typeof BPM_SOURCES)[number];

/**
 * Client-facing `blendAnalysis.status` on the queue contract. `complete` is the
 * DB's `measured`; a `pending` (not-yet-analyzed) track carries `blendAnalysis:
 * null` instead of a status.
 */
export const BLEND_ANALYSIS_STATUSES = ['complete', 'partial', 'unavailable', 'failed'] as const;
export type BlendAnalysisStatus = (typeof BLEND_ANALYSIS_STATUSES)[number];

/** Map track-side provenance to the queue contract status (null = nothing to report). */
export function toBlendAnalysisStatus(status: AnalysisStatus): BlendAnalysisStatus | null {
  if (status === 'pending') return null;
  if (status === 'measured') return 'complete';
  return status;
}

/**
 * A request's generation-time BLEND IDENTITY: what it was generated against.
 * Written at submit (from the compiled snapshot, or copied from the original
 * request on a Dislike reroll), carried by queue items, and consumed by the
 * edge policy. All-null = a legacy request, which always
 * forces a plain edge.
 */
export interface BlendIdentity {
  styleRevision: number | null;
  targetBpm: number | null;
  targetKey: string | null;
}

/**
 * The per-track analysis payload a queue item carries (design decisions,
 * "Contracts"). Both beat grids ship as an anchor PLUS a locally fitted period —
 * a single global BPM + head anchor cannot bound tail phase error under drift.
 * Every measurement is nullable: a `failed`/`unavailable` analysis reports its
 * status with no numbers.
 */
export const blendAnalysisSchema = z.strictObject({
  version: z.number().int().positive(),
  status: z.enum(BLEND_ANALYSIS_STATUSES),
  bpm: z.number().positive().nullable(),
  bpmSource: z.enum(BPM_SOURCES).nullable(),
  bpmConfidence: z.number().min(0).max(1).nullable(),
  headBeatAnchorSeconds: z.number().nonnegative().nullable(),
  headBeatPeriodSeconds: z.number().positive().nullable(),
  tailBeatAnchorSeconds: z.number().nonnegative().nullable(),
  tailBeatPeriodSeconds: z.number().positive().nullable(),
  integratedLufs: z.number().nullable(),
  truePeakDb: z.number().nullable(),
});
export type BlendAnalysis = z.infer<typeof blendAnalysisSchema>;

/** A track's persisted analysis fields, as the queue read returns them. */
export interface TrackAnalysisFields {
  analysisStatus: AnalysisStatus;
  analysisVersion: number | null;
  bpmEstimate: number | null;
  bpmSource: BpmSource | null;
  bpmConfidence: number | null;
  headBeatAnchorSeconds: number | null;
  headBeatPeriodSeconds: number | null;
  tailBeatAnchorSeconds: number | null;
  tailBeatPeriodSeconds: number | null;
  lufsIntegrated: number | null;
  truePeakDb: number | null;
}

/**
 * Map a track's persisted analysis to the queue contract's `blendAnalysis`, or
 * null when there is nothing valid to report: not analyzed yet (`pending`), or
 * the stored analyzer version is STALE (below `currentVersion`) — the server
 * suppresses stale analyses so the edge policy never mixes analyzer versions.
 */
export function toBlendAnalysis(
  fields: TrackAnalysisFields,
  currentVersion: number = CURRENT_ANALYSIS_VERSION,
): BlendAnalysis | null {
  const status = toBlendAnalysisStatus(fields.analysisStatus);
  if (status == null) return null;
  if (fields.analysisVersion == null || fields.analysisVersion < currentVersion) return null;
  return {
    version: fields.analysisVersion,
    status,
    bpm: fields.bpmEstimate,
    bpmSource: fields.bpmSource,
    bpmConfidence: fields.bpmConfidence,
    headBeatAnchorSeconds: fields.headBeatAnchorSeconds,
    headBeatPeriodSeconds: fields.headBeatPeriodSeconds,
    tailBeatAnchorSeconds: fields.tailBeatAnchorSeconds,
    tailBeatPeriodSeconds: fields.tailBeatPeriodSeconds,
    integratedLufs: fields.lufsIntegrated,
    truePeakDb: fields.truePeakDb,
  };
}

// --- Analysis write validation (finite/range checks on every write) -----------

/** Physical-plausibility bounds for persisted analysis values. */
export const TRACK_ANALYSIS_BOUNDS = {
  bpm: { min: 40, max: 220 },
  integratedLufs: { min: -70, max: 0 },
  truePeakDb: { min: -20, max: 3 },
  bpmConfidence: { min: 0, max: 1 },
  /** A fitted beat period may deviate at most this fraction from the target period. */
  periodToleranceFraction: 0.1,
} as const;

/** The numeric fields an analysis write may carry (all optional — status-dependent). */
export interface TrackAnalysisMeasurements {
  bpmEstimate?: number | null;
  bpmConfidence?: number | null;
  integratedLufs?: number | null;
  truePeakDb?: number | null;
  headBeatAnchorSeconds?: number | null;
  headBeatPeriodSeconds?: number | null;
  tailBeatAnchorSeconds?: number | null;
  tailBeatPeriodSeconds?: number | null;
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

/**
 * Validate an analysis write's numeric fields against the bounds above. Returns
 * the list of violations (empty = valid). `targetBpm` (the request's persisted
 * generation-time target) enables the ±10% period check; when null/absent the
 * period check is skipped (an unanchored analysis has no target period).
 */
export function validateTrackAnalysis(
  measurements: TrackAnalysisMeasurements,
  opts: { targetBpm?: number | null } = {},
): string[] {
  const problems: string[] = [];
  const { bpm, integratedLufs, truePeakDb, bpmConfidence, periodToleranceFraction } =
    TRACK_ANALYSIS_BOUNDS;

  const check = (name: string, value: number | null | undefined, min: number, max: number) => {
    if (value == null) return;
    if (!inRange(value, min, max)) problems.push(`${name} out of range [${min}, ${max}]: ${value}`);
  };

  check('bpmEstimate', measurements.bpmEstimate, bpm.min, bpm.max);
  check('bpmConfidence', measurements.bpmConfidence, bpmConfidence.min, bpmConfidence.max);
  check('integratedLufs', measurements.integratedLufs, integratedLufs.min, integratedLufs.max);
  check('truePeakDb', measurements.truePeakDb, truePeakDb.min, truePeakDb.max);
  check('headBeatAnchorSeconds', measurements.headBeatAnchorSeconds, 0, Number.MAX_VALUE);
  check('tailBeatAnchorSeconds', measurements.tailBeatAnchorSeconds, 0, Number.MAX_VALUE);

  const targetPeriod = opts.targetBpm != null && opts.targetBpm > 0 ? 60 / opts.targetBpm : null;
  for (const side of ['head', 'tail'] as const) {
    const period = measurements[`${side}BeatPeriodSeconds`];
    if (period == null) continue;
    if (!Number.isFinite(period) || period <= 0) {
      problems.push(`${side}BeatPeriodSeconds must be a positive finite number: ${period}`);
    } else if (targetPeriod != null) {
      const deviation = Math.abs(period - targetPeriod) / targetPeriod;
      if (deviation > periodToleranceFraction) {
        problems.push(
          `${side}BeatPeriodSeconds deviates ${(deviation * 100).toFixed(1)}% from the target beat period (max ${periodToleranceFraction * 100}%)`,
        );
      }
    }
  }
  return problems;
}
