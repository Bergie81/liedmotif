// `retry-saved-downloads` recurring job. `download-final-audio` gives up after
// its Graphile attempts and marks the give-up on the Track's ledger row; the
// only producers of that download run while the provider job materializes, so a
// Saved Track that gave up would otherwise keep only the provider URL until it
// expires. This hourly sweep re-enqueues the download for those Tracks.
//
// Bounded twice: one retry per give-up (the mark is cleared once the retry is
// queued, and only that retry's own last attempt sets it again), and only inside
// the provider's retention window, past which the URL can only fail. Downloads
// are free; this spends egress and disk, never a provider call.

import type { Database } from '@liedmotif/db';
import { clearOutputStorageFailure, listGivenUpSavedDownloads } from '@liedmotif/db';
import type { Task } from 'graphile-worker';
import { enqueueDownloadFinalAudio } from './enqueue';

export interface RetrySavedDownloadsDeps {
  db: Database;
  enqueueDownload: (trackId: string) => Promise<void>;
  now?: Date;
}

export async function runRetrySavedDownloads(
  deps: RetrySavedDownloadsDeps,
): Promise<{ requeued: string[] }> {
  const trackIds = await listGivenUpSavedDownloads(deps.db, { now: deps.now ?? new Date() });
  for (const trackId of trackIds) {
    // Enqueue before clearing: a failed enqueue keeps the mark, so the next run
    // retries instead of the Track dropping out of the sweep for good.
    await deps.enqueueDownload(trackId);
    await clearOutputStorageFailure(deps.db, trackId);
  }
  return { requeued: trackIds };
}

/** Bind to Graphile (recurring via `RECURRING_CRONTAB`). */
export function createRetrySavedDownloadsTask(deps: { db: Database }): Task {
  return async (_payload, helpers) => {
    const { requeued } = await runRetrySavedDownloads({
      db: deps.db,
      enqueueDownload: (trackId) => enqueueDownloadFinalAudio(helpers.addJob, trackId),
    });
    if (requeued.length > 0) {
      helpers.logger.info(`retry-saved-downloads requeued tracks=${requeued.length}`);
    }
  };
}
