// Calibration assertions for the anchored tempo estimator. These are the
// thresholds-table gates on the CI-stable synthetic ground-truth slice:
//
//   - per-anchor grid error ≤ 2 ms (bias-removed) on constant-tempo clicks,
//     ≤ 4 ms under ±0.4% linear drift,
//   - confidence floor 0.75: every clean rhythmic fixture activates (the
//     activation-rate target), ambient/weak-onset material refuses,
//   - false-positive ceiling: nothing that passes the floor may produce a grid
//     outside its error budget (measured 0% during calibration).
//
// "Bias-removed": the estimator carries a constant onset-detection
// latency (~15 ms in calibration) that cancels across an edge because beat-locking
// requires the same analyzer version on both decks — so the gate is on each
// error's deviation from the fixtures' SHARED bias, not on the raw error.

import { describe, expect, it } from 'vitest';
import { BPM_CONFIDENCE_FLOOR } from '@liedmotif/shared';
import { ambient, anchorErrorSeconds, clickTrack, jitteredClickTrack } from './analysis-fixtures';
import { estimateAnchoredTempo, type AnchoredTempoEstimate } from './estimator';

const FIXTURE_SECONDS = 180;

interface MeasuredFixture {
  name: string;
  targetBpm: number;
  estimate: AnchoredTempoEstimate;
  /** Raw head/tail anchor errors vs ground truth, in ms. */
  headErrorMs: number;
  tailErrorMs: number;
}

function measure(name: string, targetBpm: number, driftPct = 0): MeasuredFixture {
  const { pcm, truth } = clickTrack(targetBpm, FIXTURE_SECONDS, { driftPct });
  const estimate = estimateAnchoredTempo(pcm, targetBpm);
  expect(estimate.head, `${name}: head grid`).not.toBeNull();
  expect(estimate.tail, `${name}: tail grid`).not.toBeNull();
  return {
    name,
    targetBpm,
    estimate,
    headErrorMs: anchorErrorSeconds(estimate.head!.anchorSeconds, truth) * 1000,
    tailErrorMs: anchorErrorSeconds(estimate.tail!.anchorSeconds, truth) * 1000,
  };
}

// Computed once — the suite asserts several thresholds over the same corpus run.
const constantTempo = [
  measure('click-90', 90),
  measure('click-120', 120),
  measure('click-140', 140),
  measure('click-160.5', 160.5),
];
const drifting = [
  measure('click-92-drift0.4pct', 92, 0.004),
  measure('click-120-drift0.4pct', 120, 0.004),
];
// The shared constant onset-detection bias, estimated from the constant-tempo
// fixtures (calibration measured ~15.4 ms with ±0.1 ms spread).
const allConstantErrors = constantTempo.flatMap((f) => [f.headErrorMs, f.tailErrorMs]);
const biasMs = allConstantErrors.reduce((a, b) => a + b, 0) / allConstantErrors.length;

describe('estimateAnchoredTempo — thresholds-table corpus gates', () => {
  it('recovers the BPM of constant-tempo clicks within the ±10% anchored window', () => {
    for (const f of constantTempo) {
      expect(Math.abs(f.estimate.bpm - f.targetBpm), f.name).toBeLessThan(f.targetBpm * 0.01);
    }
  });

  it('holds per-anchor grid error ≤ 2 ms (bias-removed) at head AND tail on constant tempo', () => {
    for (const f of constantTempo) {
      expect(Math.abs(f.headErrorMs - biasMs), `${f.name} head`).toBeLessThanOrEqual(2);
      expect(Math.abs(f.tailErrorMs - biasMs), `${f.name} tail`).toBeLessThanOrEqual(2);
    }
  });

  it('holds per-anchor grid error ≤ 4 ms (bias-removed) under ±0.4% linear drift', () => {
    for (const f of drifting) {
      expect(Math.abs(f.headErrorMs - biasMs), `${f.name} head`).toBeLessThanOrEqual(4);
      expect(Math.abs(f.tailErrorMs - biasMs), `${f.name} tail`).toBeLessThanOrEqual(4);
    }
  });

  it('fits head and tail periods separately: a drifting track diverges, a constant one does not', () => {
    // The edge policy's drift guard keys off head/tail period divergence —
    // the estimator must actually RESOLVE that divergence, not average it away.
    for (const f of drifting) {
      const divergence =
        Math.abs(f.estimate.head!.periodSeconds - f.estimate.tail!.periodSeconds) /
        f.estimate.tail!.periodSeconds;
      expect(divergence, `${f.name} diverges`).toBeGreaterThan(0.0025);
    }
    for (const f of constantTempo) {
      const divergence =
        Math.abs(f.estimate.head!.periodSeconds - f.estimate.tail!.periodSeconds) /
        f.estimate.tail!.periodSeconds;
      expect(divergence, `${f.name} stays flat`).toBeLessThan(0.0025);
    }
  });

  it('activates on every clean rhythmic fixture (synthetic slice)', () => {
    for (const f of [...constantTempo, ...drifting]) {
      expect(f.estimate.confidence, f.name).toBeGreaterThanOrEqual(BPM_CONFIDENCE_FLOOR);
    }
  });

  it('activates on jittered onsets (the real-music residual profile), grid still on the true beat', () => {
    // Real generated finals fit residuals of 10–25 ms with matched fractions
    // ≈ 1.0 — solid grids the prototype's FIXED residual cutoff wrongly
    // refused (measured 0/6 activation on real instrumental finals). The
    // period-relative tolerance must activate this profile, and the
    // least-squares fit must average the jitter away: the fitted anchor stays
    // within the constant-tempo budget of the TRUE (un-jittered) grid.
    for (const bpm of [92, 126]) {
      const { pcm, truth } = jitteredClickTrack(bpm, FIXTURE_SECONDS, { jitterMs: 10 });
      const estimate = estimateAnchoredTempo(pcm, bpm);
      expect(estimate.confidence, `jitter-${bpm}`).toBeGreaterThanOrEqual(BPM_CONFIDENCE_FLOOR);
      const headErrorMs = anchorErrorSeconds(estimate.head!.anchorSeconds, truth) * 1000;
      expect(Math.abs(headErrorMs - biasMs), `jitter-${bpm} head`).toBeLessThanOrEqual(4);
    }
  });

  it('refuses ambient noise (no beat) — clean fallback instead of a guess', () => {
    const { pcm } = ambient(120);
    const estimate = estimateAnchoredTempo(pcm, 100);
    expect(estimate.confidence).toBeLessThan(BPM_CONFIDENCE_FLOOR);
  });

  it('refuses a faint buried beat rather than risk a false lock', () => {
    const { pcm } = ambient(150, { beatBpm: 80, beatAmp: 0.12 });
    const estimate = estimateAnchoredTempo(pcm, 80);
    expect(estimate.confidence).toBeLessThan(BPM_CONFIDENCE_FLOOR);
  });

  it('false-positive ceiling: every fixture that passes the floor stays inside its error budget', () => {
    // On the ground-truth slice the FP rate must be 0 (ceiling ≤ 2%): passing the
    // confidence floor with an out-of-budget grid is the failure mode that would
    // audibly mis-align a beat-locked edge.
    const budget = (f: MeasuredFixture) => (drifting.includes(f) ? 4 : 2);
    for (const f of [...constantTempo, ...drifting]) {
      if (f.estimate.confidence < BPM_CONFIDENCE_FLOOR) continue;
      expect(Math.abs(f.headErrorMs - biasMs), f.name).toBeLessThanOrEqual(budget(f));
      expect(Math.abs(f.tailErrorMs - biasMs), f.name).toBeLessThanOrEqual(budget(f));
    }
  });

  it('returns a zero-confidence refusal for audio too short to analyze', () => {
    const estimate = estimateAnchoredTempo(new Float32Array(1000), 120);
    expect(estimate.confidence).toBe(0);
    expect(estimate.head).toBeNull();
    expect(estimate.tail).toBeNull();
  });
});
