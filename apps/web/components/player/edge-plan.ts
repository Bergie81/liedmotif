// One-shot edge planning: everything the
// controller must decide when a prepared deck reaches readiness, computed as a
// pure function of the two endpoints and the outgoing clock sample. Keeping the
// decision math out of the hook makes the runtime degrades — `schedule-missed`
// and `timing-unsupported` — unit-testable, and the hook's job shrinks to
// element/timer plumbing.

import {
  contextTimeForMediaTime,
  decideEdge,
  type EdgeDecision,
  type EdgeEndpoint,
  type EdgeLoudness,
  mutualLoudnessGainsDb,
  type MutualLoudnessGains,
  planAlignedEdge,
} from '@liedmotif/shared';

export interface EdgePlanInputs {
  from: EdgeEndpoint;
  to: EdgeEndpoint;
  fromLoudness: EdgeLoudness;
  toLoudness: EdgeLoudness;
  /** The prepared deck's pitch-policy rate cap (engine feature detection;
   *  buffer transport always caps at ±1.5%). */
  rateCapFraction: number;
  /** Whether the audio stack exposes a trustworthy media→context mapping
   *  (`PlayerEngine.alignedSchedulingSupported`); false ⇒ plain, always. */
  alignedSchedulingSupported: boolean;
  crossfadeSeconds: number;
  /** Outgoing deck clock sample, taken together at planning time. */
  outDurationSeconds: number;
  outPositionSeconds: number;
  outPlaybackRate: number;
  /** Context clock at the same sample; null when the graph is absent. */
  nowContextTime: number | null;
  /** Full render→speaker latency (context base+output, where exposed): the
   *  automation is armed this much earlier so fades land on the audible beat. */
  clockLatencySeconds: number;
  /** Minimum lead the element start needs (scheduling margin). */
  minLeadSeconds: number;
  /** The edge's transport for the tier decision (buffer decks may
   *  lock; media decks cap at beat-aligned). Default 'media'. */
  transport?: 'media' | 'buffer';
  /** Which timeline the outgoing clock sample lives on: an ELEMENT's
   *  `currentTime` approximates the PRESENTED (audible) position, while a
   *  BUFFER deck's exact position is RENDER-clock time (`source.start` math).
   *  Default 'element'. */
  outFrame?: 'element' | 'buffer';
  /** How the incoming start time will be consumed: an element `play()` lives
   *  on the presentation timeline; a buffer `source.start(when)` on the render
   *  clock. Default 'element'. */
  incomingTransport?: 'element' | 'buffer';
}

export interface PlannedEdge {
  /** The decision INCLUDING runtime degrades (what telemetry must report). */
  decision: EdgeDecision;
  gains: MutualLoudnessGains;
  /** Absolute context-clock schedule; null ⇒ fire as a plain threshold edge. */
  aligned: {
    /** RENDER-time fade start (latency-shifted EARLIER; automation arms here). */
    fadeStartContextTime: number;
    /** Incoming start moment. For an ELEMENT it is the `play()` time on the
     *  PRESENTATION timeline (both media elements share the output pipeline;
     *  no latency shift between them). For a BUFFER it is the
     *  `source.start(when)` time on the RENDER clock (audible `latency`
     *  later — exactly when the outgoing audio scheduled alongside it is). */
    incomingStartContextTime: number;
    /** When the fade becomes AUDIBLE at the speakers — the logical handoff
     *  (cursor, `started` report, UI) belongs to THIS moment, not render time. */
    presentationFadeStartContextTime: number;
    /** WALL/context-clock seconds (the plan's media-time fade ÷ outgoing rate). */
    fadeSeconds: number;
    incomingRate: number;
    /** How `incomingStartContextTime` is consumed (element play vs source.start). */
    incomingTransport: 'element' | 'buffer';
  } | null;
}

/** Force a decision down to plain with an explicit runtime reason —
 * IDEMPOTENT (a reason is appended once, however many degrade steps hit it). */
export function degradeEdgeDecision(
  decision: EdgeDecision,
  reason: EdgeDecision['reasons'][number],
): EdgeDecision {
  return {
    ...decision,
    tier: 'plain',
    reasons: decision.reasons.includes(reason) ? decision.reasons : [...decision.reasons, reason],
  };
}

/** The planned-edge form of the same degrade (drops the aligned schedule). */
export function degradePlannedEdge(
  planned: PlannedEdge,
  reason: EdgeDecision['reasons'][number],
): PlannedEdge {
  return { ...planned, decision: degradeEdgeDecision(planned.decision, reason), aligned: null };
}

/**
 * Decide + schedule one edge. An aligned decision (`beat-aligned` or
 * `beat-locked`) only survives when the clock mapping is trustworthy AND a
 * whole-beat plan fits ahead of the deadline — otherwise the DECISION itself
 * degrades (never a plain fade that still reports alignment).
 */
export function planEdge(inputs: EdgePlanInputs): PlannedEdge {
  const decision = decideEdge(inputs.from, inputs.to, { transport: inputs.transport ?? 'media' });
  const gains = decision.loudnessNormalized
    ? mutualLoudnessGainsDb(inputs.fromLoudness, inputs.toLoudness)
    : { fromDb: 0, toDb: 0, mutualTargetLufs: null };

  if (decision.tier === 'plain') {
    return { decision, gains, aligned: null };
  }
  if (!inputs.alignedSchedulingSupported) {
    return { decision: degradeEdgeDecision(decision, 'timing-unsupported'), gains, aligned: null };
  }
  // A buffer-outgoing deck aligns only into another decoded buffer: an
  // element's pipeline start latency is invisible to `currentTime` and only
  // cancels between two elements — against an exact buffer reference it was
  // MEASURED beyond the media budget. No shared start frame ⇒ plain.
  if (
    (inputs.outFrame ?? 'element') === 'buffer' &&
    (inputs.incomingTransport ?? 'element') === 'element'
  ) {
    return { decision: degradeEdgeDecision(decision, 'transport-mismatch'), gains, aligned: null };
  }

  const { from, to } = inputs;
  const plan =
    from.analysis?.tailBeatAnchorSeconds != null &&
    from.analysis.tailBeatPeriodSeconds != null &&
    to.analysis?.headBeatAnchorSeconds != null &&
    to.analysis.headBeatPeriodSeconds != null &&
    Number.isFinite(inputs.outDurationSeconds) &&
    inputs.outDurationSeconds > 0
      ? planAlignedEdge({
          outDurationSeconds: inputs.outDurationSeconds,
          outTail: {
            anchorSeconds: from.analysis.tailBeatAnchorSeconds,
            periodSeconds: from.analysis.tailBeatPeriodSeconds,
          },
          inHead: {
            anchorSeconds: to.analysis.headBeatAnchorSeconds,
            periodSeconds: to.analysis.headBeatPeriodSeconds,
          },
          crossfadeSeconds: inputs.crossfadeSeconds,
          earliestStartSeconds: inputs.outPositionSeconds + inputs.minLeadSeconds,
          outPlaybackRate: inputs.outPlaybackRate,
        })
      : null;
  if (plan == null || inputs.nowContextTime == null) {
    return { decision: degradeEdgeDecision(decision, 'schedule-missed'), gains, aligned: null };
  }
  // The FINAL incoming rate includes the outgoing deck's own nudge (chained
  // edges) — re-check the pitch cap on what will actually be applied.
  if (Math.abs(plan.incomingRate - 1) > inputs.rateCapFraction) {
    return { decision: degradeEdgeDecision(decision, 'rate-beyond-cap'), gains, aligned: null };
  }

  const outRate = inputs.outPlaybackRate > 0 ? inputs.outPlaybackRate : 1;
  const outFrame = inputs.outFrame ?? 'element';
  const incomingTransport = inputs.incomingTransport ?? 'element';
  // ONE timeline model covers all four deck combinations. The outgoing sample
  // maps to the fade start in ITS OWN frame: an element's `currentTime`
  // approximates the PRESENTED (audible) position; a buffer deck's exact
  // position is RENDER-clock time. Presentation = render + latency. Graph
  // AUTOMATION (AudioParam fades) applies at RENDER time, so it is always
  // armed at the render-frame fade start — for an element-outgoing edge that
  // is `presentation − latency` (armed EARLIER, or the fade lands late against
  // the audible beats); for a buffer-outgoing edge render time IS the frame
  // the beats are scheduled in, and everything shifts to the speakers
  // together. Incoming starts live where their command executes: an element
  // `play()` on the presentation timeline (both media elements share the
  // output pipeline — no shift between them), a buffer `source.start` on the
  // render clock (shifted with the automation).
  const mappedFadeStart = contextTimeForMediaTime({
    sample: { mediaTime: inputs.outPositionSeconds, contextTime: inputs.nowContextTime },
    targetMediaTime: plan.fadeStartSeconds,
    playbackRate: outRate,
  });
  const fadeStartContextTime =
    outFrame === 'element' ? mappedFadeStart - inputs.clockLatencySeconds : mappedFadeStart;
  const presentationFadeStartContextTime = fadeStartContextTime + inputs.clockLatencySeconds;
  const incomingStartContextTime =
    (incomingTransport === 'buffer' ? fadeStartContextTime : presentationFadeStartContextTime) -
    plan.incomingLeadSeconds;
  // VIABILITY on the context clock: the latency compensation moves the
  // AUTOMATION earlier — on a high-latency route (Bluetooth) a nominally
  // viable media-time plan can leave no context-clock lead for either the
  // armed fade or the pre-roll. A moment that is already (nearly) due cannot
  // be honored inside the alignment budget.
  if (
    Math.min(incomingStartContextTime, fadeStartContextTime) <
    inputs.nowContextTime + inputs.minLeadSeconds / 2
  ) {
    return { decision: degradeEdgeDecision(decision, 'schedule-missed'), gains, aligned: null };
  }
  return {
    decision,
    gains,
    aligned: {
      fadeStartContextTime,
      incomingStartContextTime,
      presentationFadeStartContextTime,
      // AudioParam automation runs on the context clock: convert the plan's
      // outgoing-media fade length to wall seconds.
      fadeSeconds: plan.fadeSeconds / outRate,
      incomingRate: plan.incomingRate,
      incomingTransport,
    },
  };
}
