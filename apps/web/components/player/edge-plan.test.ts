import { describe, expect, it } from 'vitest';
import type { BlendAnalysis, EdgeEndpoint } from '@liedmotif/shared';
import { degradeEdgeDecision, planEdge, type EdgePlanInputs } from './edge-plan';

// The one-shot edge planner: a `beat-aligned` decision must survive only when
// the clock mapping is trustworthy AND a whole-beat plan fits — every other
// outcome degrades the DECISION itself (telemetry must never claim alignment
// for a plain fade).

function analysis(over: Partial<BlendAnalysis> = {}): BlendAnalysis {
  return {
    version: 2,
    status: 'complete',
    bpm: 120,
    bpmSource: 'measured',
    bpmConfidence: 0.9,
    headBeatAnchorSeconds: 0.25,
    headBeatPeriodSeconds: 0.5,
    tailBeatAnchorSeconds: 0.25,
    tailBeatPeriodSeconds: 0.5,
    integratedLufs: -14,
    truePeakDb: -3,
    ...over,
  };
}

function endpoint(over: Partial<EdgeEndpoint> = {}): EdgeEndpoint {
  return {
    source: 'final',
    styleRevision: 1,
    targetBpm: 120,
    targetKey: 'A minor',
    analysis: analysis(),
    ...over,
  };
}

function inputs(over: Partial<EdgePlanInputs> = {}): EdgePlanInputs {
  return {
    from: endpoint(),
    to: endpoint(),
    fromLoudness: { lufs: -14, truePeakDb: -3 },
    toLoudness: { lufs: -14, truePeakDb: -3 },
    rateCapFraction: 0.06,
    alignedSchedulingSupported: true,
    crossfadeSeconds: 2,
    outDurationSeconds: 180,
    outPositionSeconds: 170,
    outPlaybackRate: 1,
    nowContextTime: 1000,
    clockLatencySeconds: 0,
    minLeadSeconds: 0.35,
    ...over,
  };
}

describe('degradeEdgeDecision', () => {
  it('appends a reason exactly once, however many degrade steps hit it', () => {
    const base = { tier: 'beat-aligned' as const, reasons: [], loudnessNormalized: true };
    const once = degradeEdgeDecision(base, 'schedule-missed');
    const twice = degradeEdgeDecision(once, 'schedule-missed');
    expect(twice.tier).toBe('plain');
    expect(twice.reasons).toEqual(['schedule-missed']);
  });
});

describe('planEdge', () => {
  it('schedules a qualified edge on the context clock', () => {
    const planned = planEdge(inputs());
    expect(planned.decision.tier).toBe('beat-aligned');
    expect(planned.aligned).not.toBeNull();
    // 2 s fade = 4 beats; deadline 178 → beat 177.75; media 170 ↦ ctx 1000,
    // so the fade starts at ctx 1007.75 and the element 0.25 s earlier.
    expect(planned.aligned?.fadeStartContextTime).toBeCloseTo(1007.75);
    expect(planned.aligned?.incomingStartContextTime).toBeCloseTo(1007.5);
    expect(planned.aligned?.fadeSeconds).toBeCloseTo(2);
  });

  it('arms the AUTOMATION earlier by the render→speaker latency — element commands stay put', () => {
    const planned = planEdge(inputs({ clockLatencySeconds: 0.05 }));
    // The graph fade is armed 50 ms early so its audible effect lands on the
    // presented beat; the incoming element's play() stays on the PRESENTATION
    // timeline (both media elements share the output pipeline — shifting the
    // start would desynchronize the two tracks by exactly the latency).
    expect(planned.aligned?.fadeStartContextTime).toBeCloseTo(1007.7);
    expect(planned.aligned?.incomingStartContextTime).toBeCloseTo(1007.5);
    expect(planned.aligned?.presentationFadeStartContextTime).toBeCloseTo(1007.75);
  });

  it('degrades when latency compensation leaves no context-clock lead (Bluetooth route)', () => {
    // Media-time plan: fade presented at 177.75, position 177.0 — a nominal
    // 750 ms of lead. A 700 ms render→speaker latency must arm the AUTOMATION
    // at ctx +50 ms: already (nearly) due — not schedulable inside the budget.
    const planned = planEdge(
      inputs({ outPositionSeconds: 177.0, minLeadSeconds: 0.2, clockLatencySeconds: 0.7 }),
    );
    expect(planned.decision.tier).toBe('plain');
    expect(planned.decision.reasons).toContain('schedule-missed');
    expect(planned.aligned).toBeNull();
  });

  it('folds an outgoing rate nudge into a chained edge (wall-clock lock)', () => {
    const planned = planEdge(inputs({ outPlaybackRate: 1.01 }));
    expect(planned.decision.tier).toBe('beat-aligned');
    // Equal media periods, outgoing at 1.01× → incoming must run at 1.01× too,
    // and the context-clock fade shortens by the same factor.
    expect(planned.aligned?.incomingRate).toBeCloseTo(1.01, 10);
    expect(planned.aligned?.fadeSeconds).toBeCloseTo(2 / 1.01, 10);
  });

  it('keeps an edge whose CHAINED rate is inside the cap even when the raw period ratio is not', () => {
    // Outgoing at 1.06×, tail 0.5 s, incoming head 0.465 s: the raw ratio is
    // 0.93 (7% off), but the applied rate 1.06 × 0.465/0.5 ≈ 0.986 is fine —
    // the cap binds the FINAL rate, not the media-period ratio.
    const slowIn = endpoint({
      analysis: analysis({ headBeatPeriodSeconds: 0.465, tailBeatPeriodSeconds: 0.465 }),
    });
    const planned = planEdge(inputs({ to: slowIn, outPlaybackRate: 1.06 }));
    expect(planned.decision.tier).toBe('beat-aligned');
    expect(planned.aligned?.incomingRate).toBeCloseTo((1.06 * 0.465) / 0.5, 10);
  });

  it('degrades to plain when the CHAINED rate would exceed the pitch cap', () => {
    // Media-period ratio alone is inside ±1.5%, but the outgoing deck already
    // runs at 1.05× — the applied rate would land outside the tight cap.
    const planned = planEdge(inputs({ outPlaybackRate: 1.05, rateCapFraction: 0.015 }));
    expect(planned.decision.tier).toBe('plain');
    expect(planned.decision.reasons).toContain('rate-beyond-cap');
  });

  it('degrades to plain with timing-unsupported when the clock mapping is untrusted', () => {
    const planned = planEdge(inputs({ alignedSchedulingSupported: false }));
    expect(planned.decision.tier).toBe('plain');
    expect(planned.decision.reasons).toContain('timing-unsupported');
    expect(planned.aligned).toBeNull();
  });

  it('degrades to plain with schedule-missed when readiness came too late', () => {
    const planned = planEdge(inputs({ outPositionSeconds: 177.9 }));
    expect(planned.decision.tier).toBe('plain');
    expect(planned.decision.reasons).toContain('schedule-missed');
    expect(planned.aligned).toBeNull();
  });

  it('a buffer↔buffer edge schedules EVERYTHING on the render clock — no latency shift', () => {
    // The outgoing sample is the buffer transport's exact render-clock
    // position; automation and `source.start` both execute at render time, so
    // they shift to the speakers together and nothing is armed early.
    const planned = planEdge(
      inputs({
        transport: 'buffer',
        outFrame: 'buffer',
        incomingTransport: 'buffer',
        clockLatencySeconds: 0.05,
        rateCapFraction: 0.015,
      }),
    );
    expect(planned.decision.tier).toBe('beat-locked');
    expect(planned.aligned?.incomingTransport).toBe('buffer');
    expect(planned.aligned?.fadeStartContextTime).toBeCloseTo(1007.75);
    expect(planned.aligned?.incomingStartContextTime).toBeCloseTo(1007.5);
    // The logical handoff still belongs to the AUDIBLE moment.
    expect(planned.aligned?.presentationFadeStartContextTime).toBeCloseTo(1007.8);
  });

  it('a MIXED media→buffer bootstrap shifts the buffer start with the automation', () => {
    // Outgoing element sample = presentation frame: automation arms latency-
    // early, and the incoming BUFFER start shifts with it (audible exactly at
    // the presented fade start), unlike an element play() which stays put.
    const planned = planEdge(
      inputs({
        transport: 'buffer',
        incomingTransport: 'buffer',
        clockLatencySeconds: 0.05,
        rateCapFraction: 0.015,
      }),
    );
    expect(planned.decision.tier).toBe('beat-locked');
    expect(planned.aligned?.fadeStartContextTime).toBeCloseTo(1007.7);
    expect(planned.aligned?.incomingStartContextTime).toBeCloseTo(1007.45);
    expect(planned.aligned?.presentationFadeStartContextTime).toBeCloseTo(1007.75);
  });

  it('a BUFFER→ELEMENT edge (decode-failure fallback) degrades to PLAIN: no shared start frame', () => {
    // An element's pipeline start latency is invisible to `currentTime` and
    // only cancels between two elements — against the buffer's exact render
    // reference it was measured beyond the media budget. The edge
    // must degrade rather than claim an alignment it cannot hold.
    const planned = planEdge(
      inputs({
        transport: 'media',
        outFrame: 'buffer',
        clockLatencySeconds: 0.05,
      }),
    );
    expect(planned.decision.tier).toBe('plain');
    expect(planned.decision.reasons).toContain('transport-mismatch');
    expect(planned.aligned).toBeNull();
    // Loudness normalization is transport-independent and still applies.
    expect(planned.gains.mutualTargetLufs).not.toBeNull();
  });

  it('buffer transport degrades to plain beyond the ±1.5% cap (larger drift → plain)', () => {
    const planned = planEdge(
      inputs({
        transport: 'buffer',
        outFrame: 'buffer',
        incomingTransport: 'buffer',
        rateCapFraction: 0.015,
        outPlaybackRate: 1.05,
      }),
    );
    expect(planned.decision.tier).toBe('plain');
    expect(planned.decision.reasons).toContain('rate-beyond-cap');
    expect(planned.aligned).toBeNull();
  });

  it('passes a plain decision through untouched, with loudness gains', () => {
    const legacy = endpoint({ styleRevision: null, targetBpm: null, targetKey: null });
    const planned = planEdge(inputs({ from: legacy }));
    expect(planned.decision.tier).toBe('plain');
    expect(planned.decision.reasons).toContain('legacy-identity');
    expect(planned.aligned).toBeNull();
    // Both sides measured LUFS → mutual gains still apply on the plain fade.
    expect(planned.gains.mutualTargetLufs).not.toBeNull();
  });

  describe('keeps each deck at its solo level when only one side has measured loudness', () => {
    // -11 LUFS with a -3 dB true peak: its solo level toward -14 LUFS is -3 dB.
    const measured = endpoint({ analysis: analysis({ integratedLufs: -11, truePeakDb: -3 }) });
    const measuredLoudness = { lufs: -11, truePeakDb: -3 };
    const unmeasured = endpoint({
      analysis: analysis({ integratedLufs: null, truePeakDb: null }),
    });
    const unmeasuredLoudness = { lufs: null, truePeakDb: null };

    it('measured → unmeasured: the outgoing deck fades out at its solo level', () => {
      const planned = planEdge(
        inputs({
          from: measured,
          to: unmeasured,
          fromLoudness: measuredLoudness,
          toLoudness: unmeasuredLoudness,
        }),
      );
      expect(planned.gains).toEqual({ fromDb: -3, toDb: 0, mutualTargetLufs: null });
      expect(planned.decision.loudnessNormalized).toBe(false);
    });

    it('unmeasured → measured: the incoming deck fades in at its solo level', () => {
      const planned = planEdge(
        inputs({
          from: unmeasured,
          to: measured,
          fromLoudness: unmeasuredLoudness,
          toLoudness: measuredLoudness,
        }),
      );
      expect(planned.gains).toEqual({ fromDb: 0, toDb: -3, mutualTargetLufs: null });
      expect(planned.decision.loudnessNormalized).toBe(false);
    });

    it('two unmeasured sides still fade at 0 dB', () => {
      const planned = planEdge(
        inputs({
          from: unmeasured,
          to: unmeasured,
          fromLoudness: unmeasuredLoudness,
          toLoudness: unmeasuredLoudness,
        }),
      );
      expect(planned.gains).toEqual({ fromDb: 0, toDb: 0, mutualTargetLufs: null });
    });
  });
});
