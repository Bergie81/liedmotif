// `poll-due-provider-jobs` recurring safety-net. The PRIMARY poll path is
// the +25s first poll scheduled at submit plus each poll self-rescheduling with
// backoff. This low-frequency scan is the backstop for a lost reschedule (a worker
// restart between persisting a poll and re-enqueuing it) or a lost first-poll enqueue:
// it finds in-flight jobs whose poll is overdue and re-enqueues one — keyed so it never
// pulls an already-scheduled poll earlier and never spawns a duplicate loop.
//
// It is also the backstop for a lost MATERIALIZATION: a recent
// `ready` job with fewer tracks than its request asked for means the terminal CAS
// landed but the crashed poll's Graphile retry never (fully) healed it — so enqueue
// `process-provider-results` for it (keyed `process:<jobId>` with `unsafe_dedupe`,
// so the every-minute scan only SEEDS a recovery and never resets a retrying or
// permanently-failed one — Graphile keeps owning the backoff).
//
// It only ENQUEUES polls/recoveries (free) for jobs that already hold a task id; it
// never submits, so it cannot spend.

import type { Database } from '@liedmotif/db';
import { listDuePollJobs, listReadyJobsMissingTracks } from '@liedmotif/db';
import type { Task } from 'graphile-worker';
import { enqueuePollPreservingSchedule, enqueueProcessProviderResults } from './enqueue';

export interface PollDueProviderJobsDeps {
  db: Database;
  now?: Date;
  stuckSubmittedGraceMs?: number;
  limit?: number;
  enqueuePoll: (providerJobId: string) => Promise<void>;
  /** Enqueue the materialization recovery for a recent `ready` job missing tracks. */
  enqueueProcessResults: (providerJobId: string) => Promise<void>;
}

export interface PollDueProviderJobsResult {
  enqueued: string[];
  /** Recent `ready` jobs missing tracks, sent to `process-provider-results`. */
  recoveries: string[];
}

export async function runPollDueProviderJobs(
  deps: PollDueProviderJobsDeps,
): Promise<PollDueProviderJobsResult> {
  const now = deps.now ?? new Date();
  const limitArg = deps.limit !== undefined ? { limit: deps.limit } : {};
  const due = await listDuePollJobs(deps.db, {
    now,
    ...(deps.stuckSubmittedGraceMs !== undefined
      ? { stuckSubmittedGraceMs: deps.stuckSubmittedGraceMs }
      : {}),
    ...limitArg,
  });
  for (const providerJobId of due) {
    await deps.enqueuePoll(providerJobId);
  }

  const recoveries = await listReadyJobsMissingTracks(deps.db, { now, ...limitArg });
  for (const providerJobId of recoveries) {
    await deps.enqueueProcessResults(providerJobId);
  }
  return { enqueued: due, recoveries };
}

/** Bind to Graphile. Both enqueues dedupe, so this safety net only ever SEEDS a
 *  missing job — never re-arms one that is already scheduled or retrying. */
export function createPollDueProviderJobsTask(deps: { db: Database }): Task {
  return async (_payload, helpers) => {
    await runPollDueProviderJobs({
      db: deps.db,
      enqueuePoll: (providerJobId) => enqueuePollPreservingSchedule(helpers.addJob, providerJobId),
      enqueueProcessResults: (providerJobId) =>
        enqueueProcessProviderResults(helpers.addJob, providerJobId),
    });
  };
}
