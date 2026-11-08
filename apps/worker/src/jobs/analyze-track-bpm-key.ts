// `analyze-track-bpm-key` job. Runs
// after final-audio download: measure the track (LUFS + true peak via ffmpeg,
// BPM via the anchored tempo estimator in a worker thread) around its REQUEST's
// persisted generation-time target (never the live snapshot — a Change Vibe may
// have replaced it since this track was generated) and persist the measurements
// WITH provenance. The task identifier is kept stable —
// pending jobs in existing databases reference it.
//
// Provenance is decided by the injected analyzer (`createWorkerTrackAnalyzer`):
// `measured` / `partial` / `unavailable` / `failed` — see its header. This job
// owns the QUEUE-side orchestration:
//   - the write is COMPARE-AND-SET on `analysis_version` (a stale in-flight job
//     can never overwrite newer results; duplicate re-runs are no-ops),
//   - a transient analyzer error rethrows so Graphile retries (bounded by the
//     enqueue's `maxAttempts: 3`); on the LAST attempt the wrapper records
//     terminal provenance — `unavailable` for host-resource shortages (the
//     boot probe reopens those), `failed` for everything else — so a track
//     never sticks `pending`.
//
// Idempotent: re-running writes the same deterministic values (or CAS-noops),
// and a deleted / audio-less track is a no-op (never resurrects audio).

import type { Database } from '@liedmotif/db';
import { getTrackForAnalysis, writeTrackAnalysis } from '@liedmotif/db';
import { CURRENT_ANALYSIS_VERSION, type AnalysisStatus, type BpmSource } from '@liedmotif/shared';
import type { TrackAudioAnalyzer } from '@liedmotif/providers';
import type { Task } from 'graphile-worker';
import { AnalysisResourceError } from '../audio/errors';
import { enqueueEmbedTrackMetadata } from './enqueue';

export interface AnalyzeTrackBpmKeyDeps {
  db: Database;
  /** The runner injects the real analyzer (built around the storage provider);
   *  tests inject deterministic fakes. */
  analyzer: TrackAudioAnalyzer;
  /** Re-tags the local MP3 once a BPM lands — the first embed usually runs
   *  before analysis completes, so the `TBPM` frame arrives via this re-enqueue.
   *  The task binding builds it per invocation from Graphile's `addJob`. */
  enqueueEmbedMetadata: (trackId: string) => Promise<void>;
  now?: Date;
}

export interface AnalyzeTrackBpmKeyPayload {
  trackId: string;
}

export interface AnalyzeTrackBpmKeyResult {
  analyzed: boolean;
  /** False when the CAS declined (a newer analysis already landed). */
  written?: boolean;
  analysisStatus?: Exclude<AnalysisStatus, 'pending'>;
  bpmEstimate?: number | null;
  bpmSource?: BpmSource | null;
}

/** Core logic, decoupled from Graphile so it is directly testable. */
export async function runAnalyzeTrackBpmKey(
  deps: AnalyzeTrackBpmKeyDeps,
  payload: AnalyzeTrackBpmKeyPayload,
): Promise<AnalyzeTrackBpmKeyResult> {
  const track = await getTrackForAnalysis(deps.db, payload.trackId);
  // Gone or evicted → nothing to measure (and never re-create audio).
  if (!track || track.status === 'deleted') return { analyzed: false };
  // The job is scheduled after download; if the final audio isn't present we
  // can't measure yet — leave it for a later run rather than guess.
  if (!track.audio.storageKey) return { analyzed: false };

  const outcome = await deps.analyzer.analyze({
    audio: track.audio,
    targetBpm: track.targetBpm,
  });
  const { written } = await writeTrackAnalysis(deps.db, {
    trackId: payload.trackId,
    analysisStatus: outcome.analysisStatus,
    analysisVersion: CURRENT_ANALYSIS_VERSION,
    analysisAttemptedAt: deps.now ?? new Date(),
    bpmEstimate: outcome.bpmEstimate,
    bpmSource: outcome.bpmSource,
    bpmConfidence: outcome.bpmConfidence,
    integratedLufs: outcome.integratedLufs,
    truePeakDb: outcome.truePeakDb,
    headBeatAnchorSeconds: outcome.headBeatAnchorSeconds,
    headBeatPeriodSeconds: outcome.headBeatPeriodSeconds,
    tailBeatAnchorSeconds: outcome.tailBeatAnchorSeconds,
    tailBeatPeriodSeconds: outcome.tailBeatPeriodSeconds,
    targetBpm: track.targetBpm,
  });
  // A landed BPM belongs in the file's `TBPM` frame; the embed job is
  // idempotent (marker check), so this only rewrites when the tag set changed.
  // A CAS-declined write enqueues nothing — the run that landed already did.
  if (written && outcome.bpmEstimate != null) {
    await deps.enqueueEmbedMetadata(payload.trackId);
  }
  return {
    analyzed: true,
    written,
    analysisStatus: outcome.analysisStatus,
    bpmEstimate: outcome.bpmEstimate,
    bpmSource: outcome.bpmSource,
  };
}

/**
 * Record terminal provenance after the FINAL retry, so exhausted transient
 * errors leave a diagnosable row instead of `pending` forever. CAS applies:
 * if a newer analysis somehow landed meanwhile, this is a no-op.
 */
export async function recordAnalysisFailure(
  deps: Pick<AnalyzeTrackBpmKeyDeps, 'db' | 'now'>,
  trackId: string,
  status: 'failed' | 'unavailable' = 'failed',
): Promise<void> {
  await writeTrackAnalysis(deps.db, {
    trackId,
    analysisStatus: status,
    analysisVersion: CURRENT_ANALYSIS_VERSION,
    analysisAttemptedAt: deps.now ?? new Date(),
  });
}

/**
 * Bind the job to the Graphile job-handler signature, including last-attempt
 * handling. Terminal shapes, chosen by error class:
 *
 *  - host-resource shortage (`AnalysisResourceError`, e.g. temp disk full):
 *    record `unavailable` and COMPLETE the job — the same "this host can't
 *    measure" provenance the ffmpeg-less path uses, reopened by the boot
 *    probe once the host recovers. Completing (not failing) also releases
 *    the versioned job key, so the post-reopen re-enqueue isn't blocked by a
 *    permanently-failed job holding it (`unsafe_dedupe` never revives those);
 *  - anything else with the `failed` write LANDED: rethrow — the row is only
 *    ever re-analyzed by an analyzer-version bump, which uses a NEW job key,
 *    so a permanently-failed job holding this key is harmless;
 *  - the terminal write itself FAILED (e.g. a brief Postgres outage): log
 *    loudly and COMPLETE. Rethrowing here would permanently fail the keyed
 *    job while the row still reads `pending` — the backfill sweep would then
 *    re-select the track forever but `unsafe_dedupe` could never re-enqueue
 *    it. Completing frees the key, and the sweep retries once the DB is back.
 */
export function createAnalyzeTrackBpmKeyTask(
  deps: Omit<AnalyzeTrackBpmKeyDeps, 'enqueueEmbedMetadata'>,
): Task {
  return async (payload, helpers) => {
    const typed = payload as AnalyzeTrackBpmKeyPayload;
    const startedAtMs = performance.now();
    try {
      const result = await runAnalyzeTrackBpmKey(
        {
          ...deps,
          enqueueEmbedMetadata: (trackId) => enqueueEmbedTrackMetadata(helpers.addJob, trackId),
        },
        typed,
      );
      // Per-run observability: status + duration, and whether
      // the write landed or CAS-noopped against a newer analysis.
      if (result.analyzed) {
        const durationMs = Math.round(performance.now() - startedAtMs);
        const landed = result.written ? 'written' : 'stale — a newer analysis already landed';
        helpers.logger.info(
          `analysis ${result.analysisStatus} for track ${typed.trackId} in ${durationMs} ms (${landed})`,
        );
      }
    } catch (err) {
      // Failing runs carry their duration too: a run
      // that burns its whole budget before failing must be visible as such.
      const durationMs = Math.round(performance.now() - startedAtMs);
      if (helpers.job.attempts < helpers.job.max_attempts) {
        helpers.logger.warn(
          `analysis attempt ${helpers.job.attempts}/${helpers.job.max_attempts} for track ` +
            `${typed.trackId} failed after ${durationMs} ms; retrying: ${String(err)}`,
        );
        throw err;
      }

      const isResource = err instanceof AnalysisResourceError;
      const terminalStatus = isResource ? 'unavailable' : 'failed';
      try {
        await recordAnalysisFailure(deps, typed.trackId, terminalStatus);
      } catch (writeErr) {
        helpers.logger.error(
          `analysis for track ${typed.trackId} exhausted retries after ${durationMs} ms ` +
            `(${String(err)}) AND the terminal ${terminalStatus} write failed ` +
            `(${String(writeErr)}); completing so the backfill sweep can retry once the ` +
            'database recovers',
        );
        return;
      }
      if (isResource) {
        helpers.logger.warn(
          `analysis resources exhausted for track ${typed.trackId} after ${durationMs} ms; ` +
            `recorded unavailable: ${String(err)}`,
        );
        return;
      }
      helpers.logger.warn(
        `analysis failed terminally for track ${typed.trackId} after ${durationMs} ms; ` +
          `recorded failed: ${String(err)}`,
      );
      throw err;
    }
  };
}
