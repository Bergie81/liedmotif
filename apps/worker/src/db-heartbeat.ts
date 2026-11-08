// The DB half of the heartbeat: the file half (`heartbeat.ts`) feeds only the
// Docker healthcheck, so the worker also upserts a `WorkerHeartbeat` record the
// web's diagnostics can read. Best-effort by contract — a DB outage must never
// take the file heartbeat (or the process) with it, and with the DB down,
// staleness IS the correct diagnostics signal. Failure logs are throttled to
// state transitions so a 10 s interval can't flood the log.

import type { WorkerHeartbeat } from '@liedmotif/db';
import type { WorkerReadiness } from './heartbeat';

export interface DbHeartbeatDeps {
  write: (record: WorkerHeartbeat) => Promise<void>;
  logWarn: (message: string, context: Record<string, unknown>) => void;
  logInfo: (message: string) => void;
  /** The runner's job-slot count — only the worker can resolve it. */
  concurrency: number;
  /** Boot time, captured once so diagnostics can show worker uptime. */
  startedAt: Date;
  pid?: number;
}

/** A publish function that upserts the heartbeat record for the given state. */
export function createDbHeartbeatWriter(
  deps: DbHeartbeatDeps,
): (state: WorkerReadiness, now?: Date) => Promise<void> {
  const startedAt = deps.startedAt.toISOString();
  const pid = deps.pid ?? process.pid;
  let failing = false;
  return async (state, now = new Date()) => {
    try {
      await deps.write({
        ts: now.toISOString(),
        pid,
        state,
        concurrency: deps.concurrency,
        startedAt,
      });
      if (failing) {
        failing = false;
        deps.logInfo('db heartbeat recovered');
      }
    } catch (err) {
      if (!failing) {
        failing = true;
        deps.logWarn('db heartbeat write failed; diagnostics will show the worker as stale', {
          err,
        });
      }
    }
  };
}
