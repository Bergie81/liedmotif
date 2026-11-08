// The edge policy: transition tiers and degradation rules.
//
// Every transition resolves into one of three tiers. Provenance gates alignment:
// measured BPM counts only with `status: 'complete'`, `bpmSource: 'measured'`, a
// non-null measured value, confidence at/above the corpus-fixed floor, and the
// CURRENT analyzer version on both decks (the estimator's constant
// onset-detection bias cancels across an edge only when both sides ran the same
// analyzer — and only a version this build knows has trusted anchor semantics).
// Identity gates it too: same style
// revision (a Change Vibe boundary is always plain), matching target key, and a
// null (legacy) identity always forces plain. A track whose own
// head/tail fitted periods diverge beyond 0.25% caps the edge at `beat-aligned`
// (a single grid can't bound both ends' phase error). The
// PITCH CAP is not decided here: the applied rate depends on the outgoing
// deck's live playback rate (chained edges), so the scheduler enforces it once
// on the final rate (`rate-beyond-cap` is its runtime degrade). Loudness
// normalization is independent: it applies whenever BOTH sides carry a
// measured LUFS, even on plain edges (`partial` = loudness-only by design).

import {
  BPM_CONFIDENCE_FLOOR,
  CURRENT_ANALYSIS_VERSION,
  type BlendAnalysis,
} from '../contracts/blend';

/** Which pinned URL actually loaded on the deck (source ladder). */
export type CommittedSourceKind = 'final' | 'stream';

/** One side of a transition, as the queue contract + source commit describe it. */
export interface EdgeEndpoint {
  source: CommittedSourceKind;
  styleRevision: number | null;
  targetBpm: number | null;
  targetKey: string | null;
  analysis: BlendAnalysis | null;
}

/** The named transition tiers. */
export type EdgeTier = 'plain' | 'beat-aligned' | 'beat-locked';

/** Why an edge degraded below the qualified tier (empty when fully qualified).
 * The last five are RUNTIME degrades the scheduler/driver adds after
 * `decideEdge`: `rate-beyond-cap` — the FINAL applied rate (incl. the outgoing
 * deck's own nudge) would exceed the pitch cap; `schedule-missed` — the
 * aligned plan could not be honored in time (late readiness, no beat left
 * before the deadline); `timing-unsupported` — the audio stack exposes no
 * trustworthy media→context clock mapping (WebKit
 * degrades to unaligned); `start-missed` — the scheduled incoming element
 * start was rejected, stayed pending, or landed too late to hold the beat; `prepare-failed` — the
 * next track never reached readiness at all (deadline passed / ladder
 * exhausted) and the transition fell back to a sequential natural-end advance;
 * `transport-mismatch` — the outgoing deck plays a DECODED BUFFER (exact
 * render-clock reference) while the incoming can only start as an element:
 * an element's pipeline start latency is invisible to `currentTime` and only
 * cancels between two elements, so no shared start frame bounds the media
 * budget — the edge stays a plain crossfade. */
export type EdgeDegradeReason =
  | 'source-not-final'
  | 'legacy-identity'
  | 'revision-mismatch'
  | 'key-mismatch'
  | 'analysis-missing'
  | 'bpm-not-measured'
  | 'confidence-below-floor'
  | 'version-mismatch'
  | 'rate-beyond-cap'
  | 'schedule-missed'
  | 'timing-unsupported'
  | 'start-missed'
  | 'prepare-failed'
  | 'transport-mismatch';

export interface EdgeDecision {
  tier: EdgeTier;
  reasons: EdgeDegradeReason[];
  /** Both endpoints measured LUFS → mutual-target normalization applies. */
  loudnessNormalized: boolean;
}

export interface EdgePolicyOptions {
  /** Media decks cap at `beat-aligned`; buffer transport may lock. */
  transport: 'media' | 'buffer';
  confidenceFloor?: number;
  /** Max head/tail fitted-period divergence within one track before the edge
   *  is capped at `beat-aligned` (0.25%). */
  driftGuardFraction?: number;
  /** The analyzer version THIS build understands (alignment needs
   *  the CURRENT analyzer version — a rolling deployment can hand an older
   *  client two matching FUTURE versions whose anchor semantics it does not
   *  know; those must stay plain). */
  currentAnalysisVersion?: number;
}

/** Head/tail-period divergence within one track, as a fraction of their mean. */
export const DEFAULT_DRIFT_GUARD_FRACTION = 0.0025;

/** The complete grids alignment schedules against, or null when any part is missing. */
function gridsOf(analysis: BlendAnalysis | null): {
  headAnchor: number;
  headPeriod: number;
  tailAnchor: number;
  tailPeriod: number;
} | null {
  if (
    analysis == null ||
    analysis.headBeatAnchorSeconds == null ||
    analysis.headBeatPeriodSeconds == null ||
    analysis.tailBeatAnchorSeconds == null ||
    analysis.tailBeatPeriodSeconds == null
  ) {
    return null;
  }
  return {
    headAnchor: analysis.headBeatAnchorSeconds,
    headPeriod: analysis.headBeatPeriodSeconds,
    tailAnchor: analysis.tailBeatAnchorSeconds,
    tailPeriod: analysis.tailBeatPeriodSeconds,
  };
}

function measuredBpmQualifies(analysis: BlendAnalysis, floor: number): boolean {
  return (
    analysis.status === 'complete' &&
    analysis.bpmSource === 'measured' &&
    analysis.bpm != null &&
    analysis.bpmConfidence != null &&
    analysis.bpmConfidence >= floor
  );
}

function headTailDivergence(grids: { headPeriod: number; tailPeriod: number }): number {
  const mean = (grids.headPeriod + grids.tailPeriod) / 2;
  return mean > 0 ? Math.abs(grids.headPeriod - grids.tailPeriod) / mean : Number.POSITIVE_INFINITY;
}

/** Decide the transition tier + normalization for the edge `from` → `to`. */
export function decideEdge(
  from: EdgeEndpoint,
  to: EdgeEndpoint,
  opts: EdgePolicyOptions,
): EdgeDecision {
  const floor = opts.confidenceFloor ?? BPM_CONFIDENCE_FLOOR;
  const driftGuard = opts.driftGuardFraction ?? DEFAULT_DRIFT_GUARD_FRACTION;
  const reasons: EdgeDegradeReason[] = [];

  // Loudness normalization is provenance-gated only by the LUFS measurement
  // itself — it needs no grids, no version equality, and no shared identity.
  const loudnessNormalized =
    from.analysis?.integratedLufs != null && to.analysis?.integratedLufs != null;

  if (from.source !== 'final' || to.source !== 'final') reasons.push('source-not-final');

  // EVERY component of the generation-time identity must be present: new
  // submits always freeze revision + BPM + key (template.ts fills unfrozen
  // parameters), so any null is a legacy/partial row — and a null identity
  // always forces a plain edge, never a silent guess.
  if (
    from.styleRevision == null ||
    to.styleRevision == null ||
    from.targetBpm == null ||
    to.targetBpm == null ||
    from.targetKey == null ||
    to.targetKey == null
  ) {
    reasons.push('legacy-identity');
  } else if (from.styleRevision !== to.styleRevision) {
    reasons.push('revision-mismatch');
  } else if (from.targetKey !== to.targetKey) {
    reasons.push('key-mismatch');
  }

  const fromGrids = gridsOf(from.analysis);
  const toGrids = gridsOf(to.analysis);
  if (from.analysis == null || to.analysis == null || fromGrids == null || toGrids == null) {
    reasons.push('analysis-missing');
  } else {
    if (!measuredBpmQualifies(from.analysis, floor) || !measuredBpmQualifies(to.analysis, floor)) {
      if (from.analysis.bpmSource !== 'measured' || to.analysis.bpmSource !== 'measured') {
        reasons.push('bpm-not-measured');
      }
      if (
        (from.analysis.bpmConfidence != null && from.analysis.bpmConfidence < floor) ||
        (to.analysis.bpmConfidence != null && to.analysis.bpmConfidence < floor)
      ) {
        reasons.push('confidence-below-floor');
      }
      if (reasons.length === 0) reasons.push('bpm-not-measured');
    }
    // Alignment needs the CURRENT analyzer version on BOTH decks —
    // equality alone would let two matching FUTURE versions (rolling
    // deployment: newer worker, older web build) activate with anchor
    // semantics this client does not know. The server already suppresses
    // versions BELOW current; this closes the other direction.
    const currentVersion = opts.currentAnalysisVersion ?? CURRENT_ANALYSIS_VERSION;
    if (from.analysis.version !== currentVersion || to.analysis.version !== currentVersion) {
      reasons.push('version-mismatch');
    }
  }

  if (reasons.length > 0) {
    return { tier: 'plain', reasons, loudnessNormalized };
  }

  // Qualified. Within-track tempo instability caps the tier at beat-aligned.
  const driftCapped =
    fromGrids != null &&
    toGrids != null &&
    (headTailDivergence(fromGrids) > driftGuard || headTailDivergence(toGrids) > driftGuard);
  const tier: EdgeTier =
    opts.transport === 'buffer' && !driftCapped ? 'beat-locked' : 'beat-aligned';
  return { tier, reasons, loudnessNormalized };
}
