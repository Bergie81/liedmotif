import { describe, expect, it } from 'vitest';
import { snapLoopRegion, waveformBars } from './section-loop';

describe('waveformBars', () => {
  it('gives one value per bar, the loudest bar at 1', () => {
    const samples = Float32Array.from([1, -1, 1, -1, 0.5, -0.5, 0.5, -0.5]);
    expect(waveformBars(samples, 2)).toEqual([1, 0.25]);
  });

  it('stretches loudness so quieter sections read as lower bars', () => {
    const samples = Float32Array.from([0.8, 0.8, 0.4, 0.4, 0.2, 0.2]);
    const [loud, mid, quiet] = waveformBars(samples, 3) as [number, number, number];
    expect(loud).toBeCloseTo(1);
    expect(mid).toBeCloseTo(0.25);
    expect(quiet).toBeCloseTo(0.0625);
  });

  it('reads silence as all zeros, never NaN', () => {
    expect(waveformBars(new Float32Array(8), 2)).toEqual([0, 0]);
  });

  it('still fills every bar when there are fewer samples than bars', () => {
    expect(waveformBars(Float32Array.from([1]), 3)).toEqual([1, 1, 1]);
    expect(waveformBars(new Float32Array(0), 2)).toEqual([0, 0]);
  });

  it('samples a full-length Track evenly across its bars', () => {
    const samples = new Float32Array(48000 * 180).fill(0.5);
    const bars = waveformBars(samples, 96);
    expect(bars).toHaveLength(96);
    expect(bars.every((value) => value === 1)).toBe(true);
  });
});

describe('snapLoopRegion', () => {
  const grid = {
    bpmConfidence: 0.9,
    headBeatAnchorSeconds: 0.25,
    headBeatPeriodSeconds: 0.5,
    tailBeatAnchorSeconds: 100.3,
    tailBeatPeriodSeconds: 0.5,
  };
  const duration = 120;
  const region = (startSeconds: number, endSeconds: number) => ({ startSeconds, endSeconds });

  it('lands the start on the nearest beat and the length on whole beats', () => {
    // 10.1 s is nearest beat 10.25; 4.1 s is nearest 8 beats, 4 s.
    expect(
      snapLoopRegion(region(10.1, 14.2), {
        durationSeconds: duration,
        analysis: grid,
        targetBpm: 90,
      }),
    ).toEqual(region(10.25, 14.25));
  });

  it('reads from the grid nearer the start, because a long Track can drift', () => {
    // Nearer the tail anchor: 100.3 − 20 × 0.5 = 90.3.
    const snapped = snapLoopRegion(region(90.1, 92.1), {
      durationSeconds: duration,
      analysis: grid,
      targetBpm: null,
    });
    expect(snapped.startSeconds).toBeCloseTo(90.3);
    expect(snapped.endSeconds).toBeCloseTo(92.3);
  });

  it('keeps the start but times the length when only a target tempo is known', () => {
    // 100 BPM is 0.6 s a beat; 3.2 s is nearest 5 beats, 3 s.
    const snapped = snapLoopRegion(region(10.1, 13.3), {
      durationSeconds: duration,
      analysis: null,
      targetBpm: 100,
    });
    expect(snapped.startSeconds).toBe(10.1);
    expect(snapped.endSeconds).toBeCloseTo(13.1);
  });

  it('distrusts a low-confidence grid and falls back to the target tempo', () => {
    const snapped = snapLoopRegion(region(10.1, 13.3), {
      durationSeconds: duration,
      analysis: { ...grid, bpmConfidence: 0.1 },
      targetBpm: 100,
    });
    expect(snapped.startSeconds).toBe(10.1);
    expect(snapped.endSeconds).toBeCloseTo(13.1);
  });

  it('leaves the marks alone when nothing is known about the tempo', () => {
    expect(
      snapLoopRegion(region(10.1, 13.3), {
        durationSeconds: duration,
        analysis: null,
        targetBpm: null,
      }),
    ).toEqual(region(10.1, 13.3));
  });

  it('never makes a loop shorter than a second', () => {
    expect(
      snapLoopRegion(region(5, 5.3), {
        durationSeconds: duration,
        analysis: grid,
        targetBpm: null,
      }),
    ).toEqual(region(5.25, 6.25));
  });

  it('gives up whole beats rather than run into the end of the Track', () => {
    // 28.25 + 4 beats = 30.25, past 29.5 (0.5 s short of the end): 2 beats fit.
    expect(
      snapLoopRegion(region(28, 29.9), { durationSeconds: 30, analysis: grid, targetBpm: null }),
    ).toEqual(region(28.25, 29.25));
  });

  it('keeps raw marks inside the Track when they cannot snap', () => {
    expect(
      snapLoopRegion(region(29, 30), { durationSeconds: 30, analysis: null, targetBpm: null }),
    ).toEqual(region(28.5, 29.5));
  });
});
