// `salvage-timed-out-finals` recurring job. A poll that runs out its attempt
// budget after the stream stage terminalizes the job with stream-only Tracks:
// paid audio that plays from the provider stream but has no final to download,
// so it never gets a local file or a measured duration, and a Saved copy dies
// with the stream URL. The provider task often completes minutes later, but a
// terminal job is never polled again.
//
// This sweep re-reads those tasks (a FREE status call — never
// `createGenerationTask`) and attaches any final that arrived to the job's
// existing live Tracks through the same idempotent materialization the poll
// uses, which enqueues their downloads. It never creates a Track, never
// revives a disliked or deleted one, and leaves the job and its request failed.

import type { Database } from '@liedmotif/db';
import {
  getProviderJobForPoll,
  listLiveProviderTrackIds,
  listTimedOutJobsAwaitingFinals,
} from '@liedmotif/db';
import type { MusicProvider } from '@liedmotif/providers';
import type { LogFields } from '@liedmotif/shared';
import type { Task } from 'graphile-worker';
import { requireEncryptionKey } from './encryption-key';
import { enqueueBufferRefill, enqueueDownloadFinalAudio } from './enqueue';
import { runProcessProviderResults } from './process-provider-results';

export interface SalvageTimedOutFinalsDeps {
  db: Database;
  /** Resolved only once a task needs re-reading, so an instance with no music key
   *  yet runs this sweep quietly. */
  getMusic: () => Promise<MusicProvider>;
  encryptionKey: Buffer;
  enqueueDownload: (trackId: string) => Promise<void>;
  enqueueBuffer: (sessionId: string) => Promise<void>;
  now?: Date;
  info?: (message: string, fields?: LogFields) => void;
}

export async function runSalvageTimedOutFinals(
  deps: SalvageTimedOutFinalsDeps,
): Promise<{ salvagedTrackIds: string[] }> {
  const salvagedTrackIds: string[] = [];
  const jobIds = await listTimedOutJobsAwaitingFinals(deps.db, { now: deps.now ?? new Date() });
  if (jobIds.length === 0) return { salvagedTrackIds };
  const music = await deps.getMusic();
  for (const jobId of jobIds) {
    const job = await getProviderJobForPoll(deps.db, jobId);
    if (!job?.providerTaskId) continue;
    let status;
    try {
      status = await music.getGenerationStatus(job.providerTaskId);
    } catch {
      // One unreadable task must not starve the rest; the next sweep reads it again.
      deps.info?.('final salvage read failed', { providerJobId: jobId });
      continue;
    }
    const live = new Set(await listLiveProviderTrackIds(deps.db, jobId));
    const finals = status.tracks.filter(
      (track) => track.audioUrl && track.providerTrackId && live.has(track.providerTrackId),
    );
    if (finals.length === 0) continue;
    const { downloadsEnqueued } = await runProcessProviderResults(deps, { job, tracks: finals });
    salvagedTrackIds.push(...downloadsEnqueued);
  }
  return { salvagedTrackIds };
}

/** Bind to Graphile (recurring via `RECURRING_CRONTAB`). */
export function createSalvageTimedOutFinalsTask(deps: {
  db: Database;
  getMusic: () => Promise<MusicProvider>;
  encryptionKey: Buffer | null;
}): Task {
  return async (_payload, helpers) => {
    const { salvagedTrackIds } = await runSalvageTimedOutFinals({
      db: deps.db,
      getMusic: deps.getMusic,
      encryptionKey: requireEncryptionKey(deps.encryptionKey),
      enqueueDownload: (trackId) => enqueueDownloadFinalAudio(helpers.addJob, trackId),
      enqueueBuffer: (sessionId) => enqueueBufferRefill(helpers.addJob, sessionId),
      info: (message, fields) => helpers.logger.info(message, fields),
    });
    if (salvagedTrackIds.length > 0) {
      helpers.logger.info(
        `salvage-timed-out-finals attached finals tracks=${salvagedTrackIds.length}`,
      );
    }
  };
}
