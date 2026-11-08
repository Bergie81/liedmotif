// Worker-boot analysis probe: when a host that previously had no ffmpeg (its
// tracks carry `unavailable` provenance) gains one — image upgrade, package
// install — the probe flips those rows back to `pending` with a NULL analysis
// version, which makes them selectable by the `backfill-track-analysis` sweep
// and writable past the CAS guard. Without ffmpeg the probe does nothing:
// `unavailable` rows stay parked (never re-selected) until the boot probe
// finds ffmpeg.

import type { Database } from '@liedmotif/db';
import { resetUnavailableTrackAnalyses } from '@liedmotif/db';
import { CURRENT_ANALYSIS_VERSION } from '@liedmotif/shared';
import { isFfmpegAvailable } from './ffmpeg';

export interface AnalysisBootProbeResult {
  ffmpegAvailable: boolean;
  /** Tracks re-opened for analysis (the backfill sweep enqueues them). */
  resetTrackIds: string[];
}

export async function runAnalysisBootProbe(
  db: Database,
  options: { probe?: typeof isFfmpegAvailable } = {},
): Promise<AnalysisBootProbeResult> {
  const ffmpegAvailable = await (options.probe ?? isFfmpegAvailable)();
  if (!ffmpegAvailable) return { ffmpegAvailable, resetTrackIds: [] };
  // Never reset rows stamped by a NEWER analyzer (rolling deployments).
  const resetTrackIds = await resetUnavailableTrackAnalyses(db, {
    currentVersion: CURRENT_ANALYSIS_VERSION,
  });
  return { ffmpegAvailable, resetTrackIds };
}
