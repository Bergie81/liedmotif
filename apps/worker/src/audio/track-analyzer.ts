// The real per-track analyzer: stage the downloaded final out of storage,
// measure loudness + true peak with ffmpeg, decode PCM, and run the anchored
// tempo estimator in a worker thread. Every stage is bounded and the whole run
// sits under one job deadline (staging ≤ 30 s, each pass ≤ 60 s, job ≤ 150 s).
//
// Provenance rules:
//   - no ffmpeg on this host        → `unavailable` + anchored BPM (the boot
//     probe re-enqueues these when ffmpeg appears),
//   - guard violation / bad input / loudness outside the write bounds →
//     `failed` (permanent, with a sanitized diagnostic),
//   - LUFS measured, BPM below the confidence floor (or no target to anchor
//     to, or a fitted grid the write bounds would reject) → `partial` +
//     anchored BPM — loudness normalization without beat-lock,
//   - confidence ≥ floor with plausible grids → `measured` (the ONLY
//     provenance that can ever activate beat-locking).
//
// Transient trouble (ffmpeg exit, staging I/O, resource shortage, thread
// death) REJECTS so the job's bounded retries run; after the last attempt the
// job wrapper records `failed` — or `unavailable` for host-resource
// shortages, which the boot probe later reopens.

import {
  anchoredBpmEstimate,
  type TrackAnalysisOutcome,
  type TrackAudioAnalysisInput,
  type TrackAudioAnalyzer,
} from '@liedmotif/providers';
import {
  BPM_CONFIDENCE_FLOOR,
  TRACK_ANALYSIS_BOUNDS,
  validateTrackAnalysis,
} from '@liedmotif/shared';
import type { StorageProvider } from '@liedmotif/storage';
import type { AnchoredTempoEstimate } from './estimator';
import { runEstimatorInThread } from './estimator-thread';
import { AnalysisInputError } from './errors';
import {
  decodePcmMono,
  FFMPEG_PASS_TIMEOUT_MS,
  isFfmpegAvailable,
  measureLoudness,
} from './ffmpeg';
import { stageAnalysisAudio, STAGING_TIMEOUT_MS, type StagedAudio } from './staging';

/** Thresholds table: whole analysis job ≤ 150 s. */
export const ANALYSIS_JOB_DEADLINE_MS = 150_000;
/** Input guard: refuse implausibly long inputs (≤ 15 min). */
export const MAX_ANALYSIS_INPUT_SECONDS = 15 * 60;
/** The availability probe's slice of the deadline (execFile bounds it too). */
const PROBE_TIMEOUT_MS = 10_000;
/** Temp-dir sweep runs even after a lost deadline race, but never hangs the job. */
const CLEANUP_TIMEOUT_MS = 10_000;

export interface WorkerTrackAnalyzerDeps {
  storage: StorageProvider;
  /** Injectables so tests cover every path without ffmpeg or real threads. */
  probeFfmpeg?: typeof isFfmpegAvailable;
  stage?: typeof stageAnalysisAudio;
  measure?: typeof measureLoudness;
  decode?: typeof decodePcmMono;
  estimate?: typeof runEstimatorInThread;
  jobDeadlineMs?: number;
}

const NOTHING_MEASURED = {
  integratedLufs: null,
  truePeakDb: null,
  headBeatAnchorSeconds: null,
  headBeatPeriodSeconds: null,
  tailBeatAnchorSeconds: null,
  tailBeatPeriodSeconds: null,
} as const;

function unavailableOutcome(input: TrackAudioAnalysisInput): TrackAnalysisOutcome {
  return {
    ...anchoredBpmEstimate(input),
    analysisStatus: 'unavailable',
    ...NOTHING_MEASURED,
    diagnostic: 'ffmpeg not available on this host',
  };
}

function failedOutcome(diagnostic: string): TrackAnalysisOutcome {
  return {
    analysisStatus: 'failed',
    bpmEstimate: null,
    bpmSource: null,
    bpmConfidence: null,
    ...NOTHING_MEASURED,
    diagnostic,
  };
}

/** Loudness measured, BPM anchored — the one shape both refusal paths (no
 *  target to anchor to; confidence below the floor) must share exactly. */
function partialOutcome(
  input: TrackAudioAnalysisInput,
  lufsFields: Pick<TrackAnalysisOutcome, 'integratedLufs' | 'truePeakDb'>,
): TrackAnalysisOutcome {
  return {
    ...anchoredBpmEstimate(input),
    analysisStatus: 'partial',
    ...NOTHING_MEASURED,
    ...lufsFields,
  };
}

/**
 * Would this estimate survive the analysis write bounds as a `measured` row?
 * The estimator is constrained to ±10% around the target, but a least-squares
 * grid can nudge past the write validation's period tolerance at the window
 * edge — downgrade to `partial` instead of throwing away the whole run.
 */
function isPersistableMeasurement(estimate: AnchoredTempoEstimate, targetBpm: number): boolean {
  const { head, tail } = estimate;
  if (!head || !tail) return false;
  const { min, max } = TRACK_ANALYSIS_BOUNDS.bpm;
  if (!(estimate.bpm >= min && estimate.bpm <= max)) return false;
  if (head.anchorSeconds < 0 || tail.anchorSeconds < 0) return false;
  const targetPeriod = 60 / targetBpm;
  const tolerance = TRACK_ANALYSIS_BOUNDS.periodToleranceFraction;
  return [head.periodSeconds, tail.periodSeconds].every(
    (period) => Math.abs(period - targetPeriod) / targetPeriod <= tolerance,
  );
}

/** Build the worker's real analyzer around the injected storage provider. */
export function createWorkerTrackAnalyzer(deps: WorkerTrackAnalyzerDeps): TrackAudioAnalyzer {
  const probe = deps.probeFfmpeg ?? isFfmpegAvailable;
  const stage = deps.stage ?? stageAnalysisAudio;
  const measure = deps.measure ?? measureLoudness;
  const decode = deps.decode ?? decodePcmMono;
  const estimate = deps.estimate ?? runEstimatorInThread;
  const jobDeadlineMs = deps.jobDeadlineMs ?? ANALYSIS_JOB_DEADLINE_MS;
  // Availability is a per-process fact (the boot probe defines the reanalysis
  // semantics); memoize so each job doesn't spawn a probe process. Only a found
  // ffmpeg is kept: one failed spawn under load must not stamp every later
  // track `unavailable` until the next restart.
  let availability: Promise<boolean> | null = null;

  return {
    async analyze(input) {
      // The 150 s job deadline starts HERE, before anything can hang — and
      // every awaited stage below runs under a race against the remaining
      // budget, so even an operation whose own timeout doesn't cover it (an
      // S3 `stat()`, a stalled statfs, a wedged temp filesystem) cannot hold
      // the serialized analysis queue past the ceiling. Losing a race
      // abandons the stage's promise; the one abandonment that could leak
      // real state — staging, whose LATE success would strand a temp dir —
      // drains its result into an immediate cleanup below.
      const deadlineAt = Date.now() + jobDeadlineMs;
      const bounded = async <T>(
        label: string,
        stageBudgetMs: number,
        run: (budgetMs: number) => Promise<T>,
      ): Promise<T> => {
        const budgetMs = Math.min(stageBudgetMs, deadlineAt - Date.now());
        if (budgetMs <= 0) throw new Error(`analysis job deadline exceeded before ${label}`);
        let timer: NodeJS.Timeout | undefined;
        const expiry = new Promise<never>((_, rejectRace) => {
          timer = setTimeout(
            () => rejectRace(new Error(`analysis job deadline exceeded during ${label}`)),
            budgetMs,
          );
          timer.unref?.();
        });
        try {
          return await Promise.race([run(budgetMs), expiry]);
        } finally {
          clearTimeout(timer);
        }
      };

      availability ??= probe().then((found) => {
        if (!found) availability = null;
        return found;
      });
      if (!(await bounded('ffmpeg probe', PROBE_TIMEOUT_MS, () => availability!))) {
        return unavailableOutcome(input);
      }

      const { audio, targetBpm } = input;
      if (audio.durationSeconds != null && audio.durationSeconds > MAX_ANALYSIS_INPUT_SECONDS) {
        return failedOutcome(
          `input too long for analysis: ${audio.durationSeconds}s (max ${MAX_ANALYSIS_INPUT_SECONDS}s)`,
        );
      }
      if (!audio.storageKey) return failedOutcome('no stored audio to analyze');

      try {
        let stagePromise: Promise<StagedAudio> | undefined;
        let staged: StagedAudio;
        try {
          staged = await bounded('staging', STAGING_TIMEOUT_MS, (budgetMs) => {
            stagePromise = stage(deps.storage, audio.storageKey!, { timeoutMs: budgetMs });
            return stagePromise;
          });
        } catch (err) {
          // Deadline lost while staging still runs: if the abandoned stage
          // later SUCCEEDS, nobody owns its temp dir — clean it on arrival.
          void stagePromise?.then((late) => late.cleanup()).catch(() => {});
          throw err;
        }
        try {
          const loudness = await bounded('loudness pass', FFMPEG_PASS_TIMEOUT_MS, (budgetMs) =>
            measure(staged.path, { timeoutMs: budgetMs }),
          );
          const lufsFields = {
            integratedLufs: loudness.integratedLufs,
            truePeakDb: loudness.truePeakDb,
          };
          // The analysis write refuses loudness outside its plausibility
          // bounds, and a re-run measures the same file the same way, so this
          // is permanent: record it instead of burning the job's retries.
          const loudnessProblems = validateTrackAnalysis(lufsFields);
          if (loudnessProblems.length > 0) return failedOutcome(loudnessProblems.join('; '));

          // No generation-time target → nothing to anchor the search window to;
          // the honest outcome is loudness-only (`partial`, anchored BPM).
          if (targetBpm == null || !Number.isFinite(targetBpm) || targetBpm <= 0) {
            return partialOutcome(input, lufsFields);
          }

          const pcm = await bounded('pcm decode', FFMPEG_PASS_TIMEOUT_MS, (budgetMs) =>
            decode(staged.path, { timeoutMs: budgetMs }),
          );
          const tempo = await bounded('tempo estimate', FFMPEG_PASS_TIMEOUT_MS, (budgetMs) =>
            estimate(pcm, targetBpm, { timeoutMs: budgetMs }),
          );

          if (
            tempo.confidence < BPM_CONFIDENCE_FLOOR ||
            !isPersistableMeasurement(tempo, targetBpm)
          ) {
            return partialOutcome(input, lufsFields);
          }
          return {
            analysisStatus: 'measured',
            bpmEstimate: tempo.bpm,
            bpmSource: 'measured',
            bpmConfidence: tempo.confidence,
            headBeatAnchorSeconds: tempo.head!.anchorSeconds,
            headBeatPeriodSeconds: tempo.head!.periodSeconds,
            tailBeatAnchorSeconds: tempo.tail!.anchorSeconds,
            tailBeatPeriodSeconds: tempo.tail!.periodSeconds,
            ...lufsFields,
          };
        } finally {
          // Bounded independently of the (possibly exhausted) job deadline:
          // temp cleanup must run even when a stage lost its race.
          await Promise.race([
            staged.cleanup(),
            new Promise((resolve) => setTimeout(resolve, CLEANUP_TIMEOUT_MS).unref?.()),
          ]).catch(() => {});
        }
      } catch (err) {
        // Guard violations are deterministic — record `failed` instead of
        // burning retries. Everything else (incl. resource shortages and lost
        // deadline races) is transient: rethrow for Graphile's bounded retries.
        if (err instanceof AnalysisInputError) return failedOutcome(err.message);
        throw err;
      }
    },
  };
}
