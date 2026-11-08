import { describe, expect, it } from 'vitest';
import {
  headroomDb,
  mutualLoudnessGainsDb,
  soloLoudnessGainDb,
  TRUE_PEAK_CEILING_DB,
} from './edge-loudness';

describe('headroomDb', () => {
  it('is the distance from the measured true peak up to the -1 dBTP ceiling', () => {
    expect(headroomDb(-4)).toBeCloseTo(3);
    expect(headroomDb(-1.5)).toBeCloseTo(0.5);
  });

  it('is zero when the track already touches or exceeds the ceiling', () => {
    expect(headroomDb(TRUE_PEAK_CEILING_DB)).toBe(0);
    expect(headroomDb(-0.09)).toBe(0);
    expect(headroomDb(1.2)).toBe(0);
  });

  it('is zero when the true peak was never measured (no blind boosts)', () => {
    expect(headroomDb(null)).toBe(0);
  });
});

describe('soloLoudnessGainDb', () => {
  it('raises a quiet track toward the target within its headroom', () => {
    // -16 LUFS wants +2 dB to reach -14; true peak -8 leaves 7 dB headroom.
    expect(soloLoudnessGainDb({ lufs: -16, truePeakDb: -8 })).toBeCloseTo(2);
  });

  it('caps a boost at the true-peak headroom', () => {
    // Wants +4 dB but only 1 dB of headroom exists (-2 dBTP -> ceiling -1).
    expect(soloLoudnessGainDb({ lufs: -18, truePeakDb: -2 })).toBeCloseTo(1);
  });

  it('never boosts when the true peak is unknown', () => {
    expect(soloLoudnessGainDb({ lufs: -18, truePeakDb: null })).toBe(0);
  });

  it('attenuates a loud track regardless of headroom', () => {
    // Corpus reality: finals near -12 LUFS with < 1 dB headroom still attenuate.
    expect(soloLoudnessGainDb({ lufs: -12, truePeakDb: -0.7 })).toBeCloseTo(-2);
  });

  it('is 0 dB when loudness was not measured', () => {
    expect(soloLoudnessGainDb({ lufs: null, truePeakDb: -3 })).toBe(0);
  });

  it('clamps the correction magnitude', () => {
    expect(soloLoudnessGainDb({ lufs: -40, truePeakDb: -30 })).toBeCloseTo(12);
    expect(soloLoudnessGainDb({ lufs: -1, truePeakDb: -1 })).toBeCloseTo(-12);
  });
});

describe('mutualLoudnessGainsDb', () => {
  it('meets at the target when both tracks can reach it', () => {
    const { fromDb, toDb, mutualTargetLufs } = mutualLoudnessGainsDb(
      { lufs: -12, truePeakDb: -3 },
      { lufs: -16, truePeakDb: -8 },
    );
    expect(mutualTargetLufs).toBeCloseTo(-14);
    expect(fromDb).toBeCloseTo(-2);
    expect(toDb).toBeCloseTo(2);
  });

  it('attenuates the louder track toward the quieter one’s achievable level', () => {
    // The quiet track has only 1 dB of headroom: its achievable level is -15,
    // so the loud track comes DOWN to -15 rather than the quiet one boosting to -14.
    const { fromDb, toDb, mutualTargetLufs } = mutualLoudnessGainsDb(
      { lufs: -12, truePeakDb: -3 },
      { lufs: -16, truePeakDb: -2 },
    );
    expect(mutualTargetLufs).toBeCloseTo(-15);
    expect(fromDb).toBeCloseTo(-3);
    expect(toDb).toBeCloseTo(1);
  });

  it('never boosts a quiet track with an unknown true peak', () => {
    const { fromDb, toDb, mutualTargetLufs } = mutualLoudnessGainsDb(
      { lufs: -12, truePeakDb: -3 },
      { lufs: -16, truePeakDb: null },
    );
    expect(mutualTargetLufs).toBeCloseTo(-16);
    expect(fromDb).toBeCloseTo(-4);
    expect(toDb).toBeCloseTo(0);
  });

  it('applies no normalization when either loudness is unmeasured', () => {
    expect(
      mutualLoudnessGainsDb({ lufs: null, truePeakDb: null }, { lufs: -14, truePeakDb: -3 }),
    ).toEqual({ fromDb: 0, toDb: 0, mutualTargetLufs: null });
    expect(
      mutualLoudnessGainsDb({ lufs: -14, truePeakDb: -3 }, { lufs: null, truePeakDb: null }),
    ).toEqual({ fromDb: 0, toDb: 0, mutualTargetLufs: null });
  });

  it('reports NO mutual target when the clamp makes the ranges disjoint', () => {
    // −8 vs −30 LUFS with no boost headroom anywhere: the loud track can only
    // reach −20 (±12 clamp), the quiet one is stuck at −30 — no common level.
    // Best-effort gains still apply, but no target is claimed.
    const { fromDb, toDb, mutualTargetLufs } = mutualLoudnessGainsDb(
      { lufs: -8, truePeakDb: -0.5 },
      { lufs: -30, truePeakDb: -1 },
    );
    expect(mutualTargetLufs).toBeNull();
    expect(fromDb).toBeCloseTo(-12);
    expect(toDb).toBeCloseTo(0);
  });

  it('never asks the louder track to cut past the clamp even with a reachable target', () => {
    // Quiet side has headroom: target settles at the clamp-bounded floor.
    const { fromDb, toDb, mutualTargetLufs } = mutualLoudnessGainsDb(
      { lufs: -6, truePeakDb: -6 },
      { lufs: -22, truePeakDb: -8 },
    );
    // Solo levels: from −6 + (−8) = −14; to −22 + 7 (headroom-capped) = −15.
    // Wanted −15; reachable [−18, −1] ∩ [−34, −15] = [−18, −15] → target −15.
    expect(mutualTargetLufs).toBeCloseTo(-15);
    expect(fromDb).toBeCloseTo(-9);
    expect(toDb).toBeCloseTo(7);
  });

  it('leaves equal tracks untouched at the target', () => {
    const { fromDb, toDb } = mutualLoudnessGainsDb(
      { lufs: -14, truePeakDb: -3 },
      { lufs: -14, truePeakDb: -3 },
    );
    expect(fromDb).toBeCloseTo(0);
    expect(toDb).toBeCloseTo(0);
  });
});
