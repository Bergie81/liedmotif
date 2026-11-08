// Queue counts over graphile-worker's PUBLIC `graphile_worker.jobs` view (0.16+;
// the `_private_*` tables are off-limits to runtime code — tests may seed
// through them, since the public view is read-only). The view deliberately
// omits `payload`, so nothing secret can pass through here. Completed jobs are
// deleted by Graphile — these are current-state counts, not history.

import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../transactions';

export interface WorkerQueueStats {
  /** Jobs a worker holds a live lock on (Graphile reclaims locks after 4 h). */
  jobsInFlight: number;
  /** Runnable now: unlocked, due, with attempts left. Excludes the recurring
   * cron jobs parked at a future `run_at`. */
  queuedJobs: number;
  /** Out of attempts and not running — permanently failed until manually revived.
   * Graphile counts an attempt when it locks a job, so a job on its last attempt
   * only counts here once it has no live lock. */
  failedJobs: number;
}

/**
 * Best-effort by contract, like `addWorkerJob`: the `graphile_worker` schema is
 * installed out-of-band by the worker migrator, so a deployment where it is
 * missing returns `null` (diagnostics shows "Unavailable") instead of throwing.
 */
export async function getWorkerQueueStats(db: DbOrTx): Promise<WorkerQueueStats | null> {
  try {
    const result = (await db.execute(sql`
      select
        count(*) filter (
          where locked_at is not null and locked_at > now() - interval '4 hours'
        )::int as jobs_in_flight,
        count(*) filter (
          where locked_at is null and run_at <= now() and attempts < max_attempts
        )::int as queued_jobs,
        count(*) filter (
          where attempts >= max_attempts
            and (locked_at is null or locked_at <= now() - interval '4 hours')
        )::int as failed_jobs
      from graphile_worker.jobs
    `)) as {
      rows?: Array<{ jobs_in_flight: number; queued_jobs: number; failed_jobs: number }>;
    };
    const row = result.rows?.[0];
    if (!row) return null;
    return {
      jobsInFlight: row.jobs_in_flight,
      queuedJobs: row.queued_jobs,
      failedJobs: row.failed_jobs,
    };
  } catch {
    return null;
  }
}
