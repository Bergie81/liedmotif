import { describe, expect, it } from 'vitest';
import {
  beatAtOrBefore,
  contextTimeForMediaTime,
  planAlignedEdge,
  quantizedFadeBeats,
  upperEnvelopePositionSeconds,
} from './edge-schedule';

const grid = (anchorSeconds: number, periodSeconds: number) => ({ anchorSeconds, periodSeconds });

describe('beatAtOrBefore', () => {
  it('returns the latest grid beat at or before the time', () => {
    expect(beatAtOrBefore(grid(0.5, 0.5), 2.3)).toBeCloseTo(2.0);
    expect(beatAtOrBefore(grid(0.5, 0.5), 2.5)).toBeCloseTo(2.5);
  });

  it('is null before the first beat', () => {
    expect(beatAtOrBefore(grid(0.5, 0.5), 0.4)).toBeNull();
  });
});

describe('quantizedFadeBeats', () => {
  it('rounds the crossfade to whole beats', () => {
    // 6 s at 120 BPM (0.5 s beats) = 12 beats exactly.
    expect(quantizedFadeBeats(6, 0.5)).toBe(12);
    // 6 s at 92 BPM (~0.652 s) ≈ 9.2 beats → 9.
    expect(quantizedFadeBeats(6, 60 / 92)).toBe(9);
  });

  it('never quantizes below one beat', () => {
    expect(quantizedFadeBeats(0.1, 0.5)).toBe(1);
  });
});

describe('planAlignedEdge', () => {
  const outTail = grid(0.25, 0.5); // 120 BPM, beats at 0.25, 0.75, 1.25, …
  const inHead = grid(0.4, 0.5);

  it('starts the fade on a tail-grid beat at or before the deadline', () => {
    const plan = planAlignedEdge({
      outDurationSeconds: 180,
      outTail,
      inHead,
      crossfadeSeconds: 6,
      earliestStartSeconds: 100,
    });
    expect(plan).not.toBeNull();
    // 12 whole beats = 6 s; deadline 174; latest beat at or before 174 is 173.75.
    expect(plan?.fadeBeats).toBe(12);
    expect(plan?.fadeSeconds).toBeCloseTo(6);
    expect(plan?.fadeStartSeconds).toBeCloseTo(173.75);
    // The fade completes at or before the track end.
    expect(plan!.fadeStartSeconds + plan!.fadeSeconds).toBeLessThanOrEqual(180);
  });

  it('locks the incoming rate onto the outgoing tail period', () => {
    const plan = planAlignedEdge({
      outDurationSeconds: 180,
      outTail: grid(0.25, 0.5),
      inHead: grid(0.4, 0.505), // incoming runs slightly slow
      crossfadeSeconds: 6,
      earliestStartSeconds: 100,
    });
    expect(plan?.incomingRate).toBeCloseTo(0.505 / 0.5);
    // The incoming lead (audio before its first beat) is scaled by the rate.
    expect(plan?.incomingLeadSeconds).toBeCloseTo(0.4 / (0.505 / 0.5));
  });

  it('locks onto the outgoing WALL period when the outgoing deck carries a rate nudge', () => {
    // Chained edges: A→B left B at 1.01×, so B's 0.5 s media beats last
    // 0.5/1.01 wall seconds. C (media period 0.5) must run at 1.01× too.
    const plan = planAlignedEdge({
      outDurationSeconds: 180,
      outTail: grid(0.25, 0.5),
      inHead: grid(0.4, 0.5),
      crossfadeSeconds: 6,
      earliestStartSeconds: 100,
      outPlaybackRate: 1.01,
    });
    expect(plan?.incomingRate).toBeCloseTo(1.01, 10);
    // The wall lead is the head anchor at the incoming rate.
    expect(plan?.incomingLeadSeconds).toBeCloseTo(0.4 / 1.01, 10);
    // 6 wall seconds ≈ 12.12 outgoing media beats → 12 whole beats.
    expect(plan?.fadeBeats).toBe(12);
  });

  it('degrades (null) when the aligned start would already be in the past', () => {
    const plan = planAlignedEdge({
      outDurationSeconds: 180,
      outTail,
      inHead,
      crossfadeSeconds: 6,
      earliestStartSeconds: 175,
    });
    expect(plan).toBeNull();
  });

  it('degrades (null) when only the incoming PRE-ROLL start is already due', () => {
    // Fade start 173.75 is ahead of 173.5, but the incoming lead (a 1 s head
    // anchor) puts the element start at 172.75 — in the past → no alignment.
    const plan = planAlignedEdge({
      outDurationSeconds: 180,
      outTail,
      inHead: grid(1.0, 0.5),
      crossfadeSeconds: 6,
      earliestStartSeconds: 173.5,
    });
    expect(plan).toBeNull();
  });

  it('degrades (null) when the track is too short for even a one-beat fade', () => {
    const plan = planAlignedEdge({
      outDurationSeconds: 0.4,
      outTail,
      inHead,
      crossfadeSeconds: 6,
      earliestStartSeconds: 0,
    });
    expect(plan).toBeNull();
  });

  it('shortens the fade to fit a short track instead of spilling past its end', () => {
    // 12-beat fade (6 s) does not fit a 5 s track; 9 beats (4.5 s) ending at
    // 4.75 do. The incoming head anchor (0.2 s) keeps the pre-roll start
    // (0.25 − 0.2 = 0.05) schedulable.
    const plan = planAlignedEdge({
      outDurationSeconds: 5,
      outTail,
      inHead: grid(0.2, 0.5),
      crossfadeSeconds: 6,
      earliestStartSeconds: 0,
    });
    expect(plan).not.toBeNull();
    expect(plan!.fadeStartSeconds + plan!.fadeSeconds).toBeLessThanOrEqual(5);
    expect(plan!.fadeBeats).toBeGreaterThanOrEqual(1);
  });
});

describe('contextTimeForMediaTime', () => {
  it('maps a future media time onto the context clock through the playback rate', () => {
    // Sampled: media 10 s at context 100 s, rate 1 → media 16 plays at context 106.
    expect(
      contextTimeForMediaTime({
        sample: { mediaTime: 10, contextTime: 100 },
        targetMediaTime: 16,
        playbackRate: 1,
      }),
    ).toBeCloseTo(106);
  });

  it('accounts for a playback-rate nudge', () => {
    // At rate 1.01, six media seconds pass in 6/1.01 wall seconds.
    expect(
      contextTimeForMediaTime({
        sample: { mediaTime: 10, contextTime: 100 },
        targetMediaTime: 16,
        playbackRate: 1.01,
      }),
    ).toBeCloseTo(100 + 6 / 1.01);
  });

  it('schedules EARLIER by the output-pipeline latency (fade lands on the audible beat)', () => {
    // 80 ms of base+output latency: the automation must be armed 80 ms sooner
    // so its audible effect coincides with the presented media position.
    expect(
      contextTimeForMediaTime({
        sample: { mediaTime: 10, contextTime: 100 },
        targetMediaTime: 16,
        playbackRate: 1,
        outputLatencySeconds: 0.08,
      }),
    ).toBeCloseTo(105.92);
  });
});

describe('upperEnvelopePositionSeconds', () => {
  it('recovers the freshest update boundary from quantized samples', () => {
    // True position at ctx 10 is 5.0; currentTime quantizes in 20 ms steps,
    // so raw samples understate by 0..0.02 s depending on when they were read.
    const samples = [
      { mediaTime: 4.9, contextTime: 9.905 }, // read 5 ms after an update: -0.005 stale
      { mediaTime: 4.92, contextTime: 9.938 }, // -0.018 stale
      { mediaTime: 4.96, contextTime: 9.96 }, // read AT the update boundary: exact
    ];
    expect(upperEnvelopePositionSeconds(samples, 10, 1)).toBeCloseTo(5.0, 10);
  });

  it('extrapolates at the playback rate', () => {
    expect(
      upperEnvelopePositionSeconds([{ mediaTime: 2, contextTime: 100 }], 101, 1.01),
    ).toBeCloseTo(3.01, 10);
  });

  it('returns null without samples', () => {
    expect(upperEnvelopePositionSeconds([], 10, 1)).toBeNull();
  });
});
