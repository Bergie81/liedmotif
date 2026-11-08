// Per-track audio analysis contract. Runs after final-audio download and
// records the track's measurements around the REQUEST's persisted
// generation-time target BPM — never the live Style Snapshot, which a Change
// Vibe may have replaced since this track was generated.
//
// The analyzer is an INJECTABLE async interface: the worker's real analyzer
// (ffmpeg loudness + onset-autocorrelation tempo in a worker thread)
// stages audio and measures; this package ships only the dependency-free
// *target-anchored* fallback. Liedmotif generates audio at a known target BPM,
// so the fallback reports a small, deterministic drift keyed off a stable audio
// fingerprint — honest about being an estimate: `bpmSource: 'anchored'` with
// `analysisStatus: 'unavailable'` ("real measurement unavailable on this
// host"), which can NEVER activate beat-locking and is exactly what the worker
// boot probe re-enqueues once ffmpeg appears. Measured musical key is deferred;
// no analyzer produces a key at all.

import {
  hash32,
  TRACK_ANALYSIS_BOUNDS,
  type AnalysisStatus,
  type BpmSource,
} from '@liedmotif/shared';

/** A reference to a track's stored audio (the fallback decodes no bytes). */
export interface TrackAudioRef {
  /** Local storage key of the downloaded audio (a stable per-track fingerprint). */
  storageKey?: string;
  /** Content checksum, if computed at download (the preferred fingerprint). */
  checksum?: string;
  byteSize?: number;
  durationSeconds?: number;
}

/** One BPM estimate with its provenance. */
export interface TrackBpmEstimate {
  bpmEstimate: number;
  /** `measured` only when real signal analysis cleared the confidence floor. */
  bpmSource: BpmSource;
  /** Estimator confidence in [0, 1]; null when nothing was measured. */
  bpmConfidence: number | null;
}

/**
 * One analysis run's full outcome: provenance plus every measurement the
 * `tracks` analysis columns persist. Null measurements are honest "not
 * measured", never zero.
 */
export interface TrackAnalysisOutcome {
  analysisStatus: Exclude<AnalysisStatus, 'pending'>;
  bpmEstimate: number | null;
  bpmSource: BpmSource | null;
  bpmConfidence: number | null;
  integratedLufs: number | null;
  truePeakDb: number | null;
  headBeatAnchorSeconds: number | null;
  headBeatPeriodSeconds: number | null;
  tailBeatAnchorSeconds: number | null;
  tailBeatPeriodSeconds: number | null;
  /** Sanitized reason for a `failed`/`unavailable` outcome (diagnostics only —
   *  must never contain URLs or environment values). */
  diagnostic?: string;
}

/** Inputs to an analysis: the audio plus the request's generation-time target. */
export interface TrackAudioAnalysisInput {
  audio: TrackAudioRef;
  /** `generation_requests.target_bpm` — the anchor. Null on legacy requests. */
  targetBpm?: number | null;
}

/** Pluggable per-track analyzer. Implementations must resolve — a rejection is
 *  a TRANSIENT error the job queue retries; permanent problems are reported as
 *  a `failed` outcome instead. */
export interface TrackAudioAnalyzer {
  analyze(input: TrackAudioAnalysisInput): Promise<TrackAnalysisOutcome>;
}

/** Max absolute BPM drift the anchored estimate records around the target BPM. */
export const MAX_ANCHORED_BPM_DRIFT = 2;

/** Sane fallback when the request froze no target BPM (legacy rows). */
const FALLBACK_BPM = 110;

/** A stable fingerprint for one track's audio, preferring the content checksum. */
function audioFingerprint(audio: TrackAudioRef): string {
  return (
    audio.checksum ?? audio.storageKey ?? `${audio.byteSize ?? 0}:${audio.durationSeconds ?? 0}`
  );
}

/**
 * The deterministic target-anchored BPM estimate: a small fingerprint-derived
 * drift in `[-MAX_ANCHORED_BPM_DRIFT, +MAX_ANCHORED_BPM_DRIFT]` around the
 * target, clamped into the persistable range. Shared by the fallback analyzer
 * below AND the real analyzer's low-confidence/`partial` path — the anchored
 * number must be identical whichever path produced it.
 */
export function anchoredBpmEstimate(input: TrackAudioAnalysisInput): TrackBpmEstimate {
  const { min, max } = TRACK_ANALYSIS_BOUNDS.bpm;
  const targetBpm = input.targetBpm;
  const anchorBpm =
    targetBpm != null && Number.isFinite(targetBpm) ? Math.round(targetBpm) : FALLBACK_BPM;
  const span = MAX_ANCHORED_BPM_DRIFT * 2 + 1;
  const drift =
    (hash32(`bpm-drift#${audioFingerprint(input.audio)}`) % span) - MAX_ANCHORED_BPM_DRIFT;
  return {
    // Clamped into the PERSISTABLE range: the snapshot schema accepts any
    // positive BPM, and an out-of-range estimate would make every analysis
    // write throw and leave the track `pending` forever.
    bpmEstimate: Math.min(max, Math.max(min, anchorBpm + drift)),
    bpmSource: 'anchored',
    bpmConfidence: null,
  };
}

/**
 * The dependency-free fallback analyzer (see file header): target-anchored BPM,
 * nothing measured, `unavailable` provenance.
 */
export function targetAnchoredBpmAnalyzer(): TrackAudioAnalyzer {
  return {
    analyze(input) {
      return Promise.resolve({
        ...anchoredBpmEstimate(input),
        analysisStatus: 'unavailable',
        integratedLufs: null,
        truePeakDb: null,
        headBeatAnchorSeconds: null,
        headBeatPeriodSeconds: null,
        tailBeatAnchorSeconds: null,
        tailBeatPeriodSeconds: null,
        diagnostic: 'no real analyzer on this host',
      });
    },
  };
}
