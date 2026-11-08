// Mutual-target loudness normalization for a blend edge.
//
// Stored finals stay bit-identical; gain applies at playback (playback-time LUFS).
// Per-edge normalization targets the MUTUALLY ACHIEVABLE loudness: attenuate the
// louder track toward the quieter one's achievable level, and never boost a quiet
// track into headroom it lacks — positive gain is capped so that
// `truePeakDb + gain <= TRUE_PEAK_CEILING_DB`. Real corpus finals regularly have
// < 1 dB of true-peak headroom, so the cap is load-bearing, not theoretical.

import { clamp, DEFAULT_MAX_LUFS_GAIN_DB, DEFAULT_TARGET_LUFS } from './blend';

/** Per-deck true-peak ceiling. */
export const TRUE_PEAK_CEILING_DB = -1;

/** A track's measured loudness pair as the queue's `blendAnalysis` carries it. */
export interface EdgeLoudness {
  lufs: number | null;
  truePeakDb: number | null;
}

/**
 * How many dB the track can be boosted before its true peak would cross the
 * ceiling. Zero when the peak already touches the ceiling — or was never
 * measured (no blind boosts).
 */
export function headroomDb(truePeakDb: number | null): number {
  if (truePeakDb == null) return 0;
  return Math.max(0, TRUE_PEAK_CEILING_DB - truePeakDb);
}

/**
 * The playback gain that moves one track toward `targetLufs` on its own:
 * boosts are capped by the track's true-peak headroom, attenuation is not, and
 * the correction magnitude is clamped. 0 dB when loudness was not measured.
 */
export function soloLoudnessGainDb(
  loudness: EdgeLoudness,
  targetLufs: number = DEFAULT_TARGET_LUFS,
  maxAbsDb: number = DEFAULT_MAX_LUFS_GAIN_DB,
): number {
  if (loudness.lufs == null) return 0;
  const wanted = targetLufs - loudness.lufs;
  return clamp(Math.min(wanted, headroomDb(loudness.truePeakDb)), -maxAbsDb, maxAbsDb);
}

/** The per-deck gains that bring both edge endpoints to the mutual target. */
export interface MutualLoudnessGains {
  fromDb: number;
  toDb: number;
  /** The loudness both decks actually meet at; null when either side is
   *  unmeasured OR no common level is reachable (disjoint gain ranges) —
   *  callers must not gate/assert "at the mutual target" on a null. */
  mutualTargetLufs: number | null;
}

/** The loudness interval a track can actually reach under the correction
 *  clamp and its true-peak headroom. */
function reachableLevelRange(
  loudness: EdgeLoudness & { lufs: number },
  maxAbsDb: number,
): { min: number; max: number } {
  return {
    min: loudness.lufs - maxAbsDb,
    max: loudness.lufs + Math.min(headroomDb(loudness.truePeakDb), maxAbsDb),
  };
}

/**
 * Mutual-target normalization for one edge: each track's achievable level is
 * where its solo gain lands it (target-bounded, headroom-capped); the mutual
 * target is the LOWER of the two — the louder track attenuates toward the
 * quieter one's achievable level, nothing boosts beyond its headroom — and it
 * must lie inside BOTH tracks' reachable ranges (the ±`maxAbsDb` clamp bounds
 * attenuation too). When the ranges are disjoint (pathological spread), no
 * mutual target exists: each side clamps toward the other as far as it can and
 * `mutualTargetLufs` is null, so nothing downstream claims a level that was
 * never reached. No-op (0 dB both) when either loudness is unmeasured.
 */
export function mutualLoudnessGainsDb(
  from: EdgeLoudness,
  to: EdgeLoudness,
  targetLufs: number = DEFAULT_TARGET_LUFS,
  maxAbsDb: number = DEFAULT_MAX_LUFS_GAIN_DB,
): MutualLoudnessGains {
  if (from.lufs == null || to.lufs == null) {
    return { fromDb: 0, toDb: 0, mutualTargetLufs: null };
  }
  const fromLevel = from.lufs + soloLoudnessGainDb(from, targetLufs, maxAbsDb);
  const toLevel = to.lufs + soloLoudnessGainDb(to, targetLufs, maxAbsDb);
  const fromRange = reachableLevelRange({ ...from, lufs: from.lufs }, maxAbsDb);
  const toRange = reachableLevelRange({ ...to, lufs: to.lufs }, maxAbsDb);

  const wanted = Math.min(fromLevel, toLevel);
  const floor = Math.max(fromRange.min, toRange.min);
  const ceiling = Math.min(fromRange.max, toRange.max);
  const mutualTargetLufs = floor <= ceiling ? clamp(wanted, floor, ceiling) : null;
  const target = mutualTargetLufs ?? wanted;
  return {
    fromDb: clamp(target - from.lufs, -maxAbsDb, Math.min(headroomDb(from.truePeakDb), maxAbsDb)),
    toDb: clamp(target - to.lufs, -maxAbsDb, Math.min(headroomDb(to.truePeakDb), maxAbsDb)),
    mutualTargetLufs,
  };
}
