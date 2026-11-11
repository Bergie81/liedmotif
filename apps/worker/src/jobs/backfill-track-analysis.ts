// `backfill-track-analysis` recurring job. A
// low-frequency, RATE-LIMITED sweep that enqueues analysis for ready tracks
// whose downloaded final has no current-version analysis: never-analyzed
// (`pending`) rows and rows from an older analyzer version. It also drains the
// boot-probe reanalysis path — tracks a former ffmpeg-less host marked
// `unavailable` are reset to `pending` at boot (see `runAnalysisBootProbe`)
// and picked up here, batch by batch, instead of stampeding the queue.
//
// The enqueue itself is deduped (versioned job key) and pinned to the
// serialized `track-analysis` queue, so re-selecting a track before its job
// ran is harmless.

import type { Database } from '@liedmotif/db';
import {
  countTracksByAnalysisStatus,
  getUsageLimits,
  listSessionTracksMissingDuration,
  listTracksNeedingAnalysis,
  writeMeasuredTrackDuration,
} from '@liedmotif/db';
import {
  ANALYSIS_STATUSES,
  CURRENT_ANALYSIS_VERSION,
  type AnalysisStatus,
  type LogFields,
} from '@liedmotif/shared';
import type { StorageProvider } from '@liedmotif/storage';
import type { Task } from 'graphile-worker';
import { measureStoredAudioDuration } from '../audio/measure-duration';
import { enqueueAnalyzeTrack } from './enqueue';

/** Per-tick rate limit: bounds sweep cost and spreads reanalysis over time. */
export const ANALYSIS_BACKFILL_BATCH_SIZE = 10;

export interface BackfillTrackAnalysisDeps {
  db: Database;
  /** Enqueue one track's analysis (Graphile `addJob` in production). */
  enqueueAnalyze: (trackId: string) => Promise<void>;
  batchSize?: number;
  /** Measure stored audio in seconds; absent, the sweep leaves missing durations alone. */
  measureDuration?: (storageKey: string) => Promise<number>;
  warn?: (message: string, fields?: LogFields) => void;
}

export interface BackfillTrackAnalysisResult {
  enqueued: string[];
  /** Instance-wide analysis provenance counts — the sweep's observability
   *  line. Null on an idle tick: the counts are a full-table aggregate, and an
   *  instance with nothing to enqueue should not pay for a log line. */
  statusCounts: Record<AnalysisStatus, number> | null;
}

/** The one-line summary each sweep tick logs into the worker diagnostics. */
export function formatAnalysisStatusCounts(counts: Record<AnalysisStatus, number>): string {
  const parts = ANALYSIS_STATUSES.map((status) => `${status}=${counts[status]}`);
  return `track analysis status: ${parts.join(' ')}`;
}

export async function runBackfillTrackAnalysis(
  deps: BackfillTrackAnalysisDeps,
): Promise<BackfillTrackAnalysisResult> {
  const limit = deps.batchSize ?? ANALYSIS_BACKFILL_BATCH_SIZE;
  const trackIds = await listTracksNeedingAnalysis(deps.db, {
    currentVersion: CURRENT_ANALYSIS_VERSION,
    limit,
  });
  for (const trackId of trackIds) {
    await deps.enqueueAnalyze(trackId);
  }
  if (deps.measureDuration) {
    const missing = await listSessionTracksMissingDuration(deps.db, limit);
    for (const track of missing) {
      try {
        const seconds = await deps.measureDuration(track.storageKey);
        await writeMeasuredTrackDuration(deps.db, track.trackId, seconds);
      } catch (err) {
        // Unknown duration keeps generation blocked; the next sweep retries
        // independently of BPM. Logged, because a file that never decodes holds
        // its Session's generation until someone looks.
        deps.warn?.('track duration measurement failed; the next sweep retries', {
          trackId: track.trackId,
          err,
        });
      }
    }
  }
  return {
    enqueued: trackIds,
    statusCounts: trackIds.length > 0 ? await countTracksByAnalysisStatus(deps.db) : null,
  };
}

/** Bind to Graphile, using the canonical analyze enqueue (dedup + queue pin). */
export function createBackfillTrackAnalysisTask(deps: {
  db: Database;
  storage: StorageProvider;
}): Task {
  return async (_payload, helpers) => {
    const result = await runBackfillTrackAnalysis({
      db: deps.db,
      measureDuration: (storageKey) => measureStoredAudioDuration(deps.storage, storageKey),
      warn: (message, fields) => helpers.logger.warn(message, fields),
      enqueueAnalyze: async (trackId) => {
        const { maxRetriesPerJob } = await getUsageLimits(deps.db);
        await enqueueAnalyzeTrack(helpers.addJob, trackId, maxRetriesPerJob);
      },
    });
    if (result.statusCounts) {
      helpers.logger.info(
        `${formatAnalysisStatusCounts(result.statusCounts)} (enqueued ${result.enqueued.length})`,
      );
    }
  };
}
