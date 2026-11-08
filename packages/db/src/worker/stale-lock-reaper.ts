// Boot-time reaper for the job locks a crashed worker left behind.
//
// graphile-worker 0.17 releases a dead process's locks only after 4 hours, and it
// has no worker registry to consult (`_private_workers` does not exist in this
// version — liveness lives only in each row's `locked_by`/`locked_at`, where
// `locked_by` is the id of a whole worker POOL, i.e. one process). Because the
// pipeline's re-enqueues coalesce onto the SAME row via `jobKey`
// (`buffer:<sessionId>`, `poll:<providerJobId>`), a SIGKILL/OOM leaves the
// minute-cadence sweeps re-enqueuing into a LOCKED row that stays unrunnable for
// ~4h — so tracks already paid for at the provider hang until the lock ages out.
// The serialized queue rows matter as much as the job rows: the job fetch skips
// a job whose `_private_job_queues` row is unavailable, so clearing only the job
// row would leave `track-analysis` stalled for that same window.
//
// Dead is decided against the worker heartbeat, the one cross-process liveness
// signal this stack has. A worker can only have taken a lock AFTER it booted, so
// while a heartbeat is fresh every lock older than its `startedAt` belongs to a
// process that is gone, and anything newer may be executing right now. That is
// what keeps an overlapping deploy or an accidental second replica from
// releasing another process's in-flight jobs. With no heartbeat, or a stale one,
// every lock present is a dead predecessor's.
//
// Unlocking goes through `graphile_worker.force_unlock_workers` — the public
// escape hatch for exactly this (writing `_private_*` from app code is otherwise
// off-limits; reads go through the public `graphile_worker.jobs` view). It
// clears both tables for the ids given, and clearing `locked_at` recomputes the
// generated `is_available` columns, making job and queue runnable again.

import { sql } from 'drizzle-orm';
import type { Database } from '../client';
import { isWorkerHeartbeatFresh, readWorkerHeartbeat } from './heartbeat-repo';

export interface ReapStaleWorkerLocksResult {
  /** False when the `graphile_worker` schema is not installed yet (fresh DB). */
  schemaPresent: boolean;
  /** Job locks cleared this run. */
  jobsReaped: number;
  /** Serialized-queue locks cleared this run. */
  queuesReaped: number;
  /** Lock holders left alone because a live worker may still be executing them. */
  preservedHolders: number;
}

type LockHolderRow = {
  lockedBy: string;
  jobs: number;
  queues: number;
  live: boolean;
};

/**
 * Clear the job and queue locks held by worker processes that are gone. Call at
 * worker boot before starting the runner, so this process holds no locks of its
 * own yet. A no-op — reporting `schemaPresent: false` — when the schema is
 * absent, so a first boot against a fresh database never throws.
 */
export async function reapStaleWorkerLocks(db: Database): Promise<ReapStaleWorkerLocksResult> {
  const present = (await db.execute(
    sql`select to_regclass('graphile_worker._private_jobs') is not null as present`,
  )) as { rows?: Array<{ present: boolean }> };
  if (!present.rows?.[0]?.present) {
    return { schemaPresent: false, jobsReaped: 0, queuesReaped: 0, preservedHolders: 0 };
  }

  // How long a live worker has been up, as a DURATION rather than an instant:
  // `locked_at` is Postgres time and the heartbeat is written on Node's clock,
  // so subtracting them here and comparing against `now()` there keeps any skew
  // between the two out of the decision. Null when no worker is reporting.
  const heartbeat = await readWorkerHeartbeat(db);
  const nowMs = Date.now();
  const liveForSeconds =
    heartbeat && isWorkerHeartbeatFresh(heartbeat, nowMs)
      ? (nowMs - Date.parse(heartbeat.startedAt)) / 1000
      : null;

  const holders = (await db.execute(sql`
    with locked as (
      select locked_by, locked_at, true as is_job
        from graphile_worker._private_jobs where locked_by is not null
      union all
      select locked_by, locked_at, false
        from graphile_worker._private_job_queues where locked_by is not null
    )
    select locked_by as "lockedBy",
           count(*) filter (where is_job)::int as "jobs",
           count(*) filter (where not is_job)::int as "queues",
           coalesce(
             max(locked_at) >= now() - make_interval(
               secs => ${liveForSeconds}::double precision
             ),
             false
           ) as "live"
      from locked
     group by locked_by
  `)) as { rows?: LockHolderRow[] };

  const rows = holders.rows ?? [];
  const dead = rows.filter((row) => !row.live);
  if (dead.length > 0) {
    const deadIds = dead.map((row) => row.lockedBy);
    await db.execute(
      sql`select graphile_worker.force_unlock_workers(${sql.param(deadIds)}::text[])`,
    );
  }
  return {
    schemaPresent: true,
    jobsReaped: dead.reduce((total, row) => total + row.jobs, 0),
    queuesReaped: dead.reduce((total, row) => total + row.queues, 0),
    preservedHolders: rows.length - dead.length,
  };
}
