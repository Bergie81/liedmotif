// Deployment-topology guard: Liedmotif supports exactly ONE worker process per
// database. Job locks are the only exclusivity graphile-worker offers, and the
// boot reaper releases the locks it judges dead — so a scaled replica or a
// rolling deploy that overlaps old and new containers can have two processes
// running the same job. The heartbeat record is the one cross-process liveness
// signal this stack has, so a booting worker consults it before its runner (and
// before it claims the record itself).
//
// Freshness alone cannot answer the question: a worker SIGKILLed a second ago
// leaves a record exactly as fresh as a live peer's, and refusing to start there
// would crash-loop the replacement precisely when recovery matters. What
// separates them is MOVEMENT — a live peer keeps rewriting `ts` on its heartbeat
// interval; a dead one never will. So a fresh record is watched rather than
// trusted: an advancing `ts` is a live peer and this process refuses to start; a
// record that ages out (or simply never moves) belonged to a predecessor that is
// gone.
//
// The bound of the method: two workers started at the same instant against a
// database where nothing was ever reported both read nothing and both proceed.
// Detecting that needs a lock rather than a signal, and a lock held on a
// connection cannot tell a killed worker from a live one — which is the case
// that matters most. The deployment rule (`docker/README.md`) covers the rest.

import {
  isWorkerHeartbeatFresh,
  WORKER_HEARTBEAT_STALE_AFTER_MS,
  type WorkerHeartbeat,
} from '@liedmotif/db';

export interface ExclusiveWorkerSlotDeps {
  readHeartbeat: () => Promise<WorkerHeartbeat | null>;
  /** Injected so tests drive the wait without real time passing. */
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called once when a fresh record forces the watch, for a boot log line. */
  onWaiting?: (context: { pid: number; ageMs: number }) => void;
}

export type ExclusiveWorkerSlot = { status: 'clear' } | { status: 'overlap'; pid: number };

/** Three samples per heartbeat interval, so a live peer is caught on the first one. */
const POLL_INTERVAL_MS = 5_000;

/**
 * Resolve `clear` when this process may own the worker slot, `overlap` when
 * another worker process is demonstrably alive on the same database (the caller
 * then exits non-zero rather than double-processing the queue). Blocks for at
 * most one stale window while a fresh record is watched.
 */
export async function awaitExclusiveWorkerSlot(
  deps: ExclusiveWorkerSlotDeps,
): Promise<ExclusiveWorkerSlot> {
  const now = deps.now ?? Date.now;

  const first = await deps.readHeartbeat();
  if (!first || !isWorkerHeartbeatFresh(first, now())) return { status: 'clear' };

  const firstTsMs = Date.parse(first.ts);
  deps.onWaiting?.({ pid: first.pid, ageMs: now() - firstTsMs });
  // Bounded even when the record's clock runs ahead of this host's: a record
  // that stops advancing cannot hold the slot longer than one stale window.
  const deadlineMs = now() + WORKER_HEARTBEAT_STALE_AFTER_MS + POLL_INTERVAL_MS;
  while (now() < deadlineMs) {
    await deps.sleep(POLL_INTERVAL_MS);
    const next = await deps.readHeartbeat();
    if (!next) return { status: 'clear' };
    if (Date.parse(next.ts) > firstTsMs) return { status: 'overlap', pid: next.pid };
    if (!isWorkerHeartbeatFresh(next, now())) return { status: 'clear' };
  }
  return { status: 'clear' };
}
