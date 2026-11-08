import { describe, expect, it } from 'vitest';
import {
  beatPeriodSeconds,
  clamp,
  crossfadeStartSeconds,
  dbToGain,
  equalPowerFadeInCurve,
  equalPowerFadeOutCurve,
  equalPowerGains,
  gainToDb,
  loopSeam,
  loopSeamViable,
  lufsGainDb,
} from './blend';

// Live-blend math: pure, deterministic DSP used by the player's thin
// Web Audio wiring. Edge decisions and beat scheduling live in edge-policy.ts /
// edge-schedule.ts; these are the shared curves and conversions. jsdom cannot
// exercise them live, so they carry the unit coverage.

describe('clamp', () => {
  it('bounds a value to the inclusive range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe('equalPowerGains', () => {
  it('is fully outgoing at t=0 and fully incoming at t=1', () => {
    expect(equalPowerGains(0)).toEqual({ outgoing: 1, incoming: 0 });
    const end = equalPowerGains(1);
    expect(end.outgoing).toBeCloseTo(0, 10);
    expect(end.incoming).toBeCloseTo(1, 10);
  });

  it('holds constant power (out^2 + in^2 = 1) across the fade', () => {
    for (let i = 0; i <= 20; i += 1) {
      const t = i / 20;
      const { outgoing, incoming } = equalPowerGains(t);
      expect(outgoing * outgoing + incoming * incoming).toBeCloseTo(1, 10);
    }
  });

  it('crosses at equal gain near the midpoint (no power dip)', () => {
    const mid = equalPowerGains(0.5);
    expect(mid.outgoing).toBeCloseTo(mid.incoming, 10);
    expect(mid.outgoing).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it('clamps the parameter to [0,1]', () => {
    expect(equalPowerGains(-3)).toEqual(equalPowerGains(0));
    expect(equalPowerGains(3)).toEqual(equalPowerGains(1));
  });
});

describe('equalPower fade curves', () => {
  it('produce complementary, monotonic, constant-power ramps', () => {
    const steps = 33;
    const fadeIn = equalPowerFadeInCurve(steps);
    const fadeOut = equalPowerFadeOutCurve(steps);
    expect(fadeIn).toHaveLength(steps);
    expect(fadeOut).toHaveLength(steps);
    expect(fadeIn[0]).toBeCloseTo(0, 6);
    expect(fadeIn[steps - 1]).toBeCloseTo(1, 6);
    expect(fadeOut[0]).toBeCloseTo(1, 6);
    expect(fadeOut[steps - 1]).toBeCloseTo(0, 6);
    for (let i = 1; i < steps; i += 1) {
      expect(fadeIn[i]!).toBeGreaterThanOrEqual(fadeIn[i - 1]!);
      expect(fadeOut[i]!).toBeLessThanOrEqual(fadeOut[i - 1]!);
      expect(fadeIn[i]! * fadeIn[i]! + fadeOut[i]! * fadeOut[i]!).toBeCloseTo(1, 6);
    }
  });

  it('requires at least two steps', () => {
    expect(() => equalPowerFadeInCurve(1)).toThrow();
  });
});

describe('beatPeriodSeconds', () => {
  it('is 60/bpm for a positive tempo', () => {
    expect(beatPeriodSeconds(120)).toBeCloseTo(0.5, 12);
    expect(beatPeriodSeconds(90)).toBeCloseTo(2 / 3, 12);
  });
  it('is null for a missing or non-positive tempo', () => {
    expect(beatPeriodSeconds(null)).toBeNull();
    expect(beatPeriodSeconds(0)).toBeNull();
    expect(beatPeriodSeconds(-1)).toBeNull();
  });
});

describe('lufsGainDb / dbToGain / gainToDb', () => {
  it('boosts a quiet track and attenuates a loud one toward the target', () => {
    expect(lufsGainDb(-20, -14)).toBeCloseTo(6, 10);
    expect(lufsGainDb(-8, -14)).toBeCloseTo(-6, 10);
  });
  it('clamps extreme corrections to the safe window', () => {
    expect(lufsGainDb(-40, -14, 12)).toBe(12);
    expect(lufsGainDb(2, -14, 12)).toBe(-12);
  });
  it('is a no-op (0 dB) when loudness was not measured', () => {
    expect(lufsGainDb(null, -14)).toBe(0);
  });
  it('converts dB to/from linear gain', () => {
    expect(dbToGain(0)).toBeCloseTo(1, 12);
    expect(dbToGain(6)).toBeCloseTo(1.9952623, 6);
    expect(dbToGain(-6)).toBeCloseTo(0.5011872, 6);
    expect(gainToDb(1)).toBeCloseTo(0, 12);
    expect(gainToDb(dbToGain(-3))).toBeCloseTo(-3, 10);
  });
});

describe('crossfadeStartSeconds', () => {
  it('begins one crossfade-length before the track ends', () => {
    expect(crossfadeStartSeconds(180, 6)).toBe(174);
  });
  it('overlaps the whole track when it is shorter than the crossfade', () => {
    expect(crossfadeStartSeconds(4, 6)).toBe(0);
  });
});

describe('loopSeam', () => {
  it('schedules a tail->head crossfade for a single-track loop', () => {
    expect(loopSeam(60, 6)).toEqual({ headStartAt: 54, overlapSeconds: 6, restartPosition: 0 });
  });
  it('never overlaps more than half of a short track', () => {
    expect(loopSeam(4, 6)).toEqual({ headStartAt: 2, overlapSeconds: 2, restartPosition: 0 });
  });
});

describe('loopSeamViable (the too-short fallback)', () => {
  it('accepts a normal-length track at its target BPM', () => {
    expect(loopSeamViable(180, 120)).toBe(true);
  });
  it('refuses anything under the 15 s floor regardless of BPM', () => {
    expect(loopSeamViable(14.9, 200)).toBe(false);
  });
  it('refuses a track shorter than 2 bars at a slow target BPM', () => {
    // 2 bars at 30 BPM = 8 beats x 2 s = 16 s > the 15 s floor.
    expect(loopSeamViable(15.5, 30)).toBe(false);
    expect(loopSeamViable(16, 30)).toBe(true);
  });
  it('applies only the 15 s floor when the target BPM is unknown', () => {
    expect(loopSeamViable(15, null)).toBe(true);
    expect(loopSeamViable(14, null)).toBe(false);
  });
  it('refuses an unknown duration (cannot be judged)', () => {
    expect(loopSeamViable(null, 120)).toBe(false);
  });
});
