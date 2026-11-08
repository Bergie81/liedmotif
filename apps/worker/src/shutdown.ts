// Bounded shutdown for the worker process.
//
// SIGTERM stops the Graphile runner — which waits for in-flight jobs — and then
// closes the pool the runner borrows. Both talk to Postgres, so a database that
// stops answering mid-deploy holds either step open indefinitely; the container
// is then SIGKILLed with its job locks still marked live, recovered only by the
// next boot's reaper. Each step is time-boxed instead, and the boxes together
// stay under the worker's compose `stop_grace_period`.

import { teardownWithin, type TeardownDeps } from '@liedmotif/shared';
import { ANALYSIS_JOB_DEADLINE_MS } from './audio/track-analyzer';

/** A graceful stop waits for in-flight jobs, and analysis is the longest-lived
 *  of them — past its own deadline nothing is still legitimately finishing. */
const RUNNER_STOP_TIMEOUT_MS = ANALYSIS_JOB_DEADLINE_MS;

/** Ceiling on the pool close, so one checked-out client cannot outlast the stop. */
const POOL_CLOSE_TIMEOUT_MS = 10_000;

export interface WorkerShutdownDeps extends TeardownDeps {
  stopRunner: () => Promise<unknown>;
  closePool: () => Promise<unknown>;
  exit: (code: number) => void;
  runnerStopTimeoutMs?: number;
  poolCloseTimeoutMs?: number;
}

/**
 * Stop the runner, close the pool, exit. The runner goes first so in-flight jobs
 * finish against a pool that is still open; neither step can block the exit.
 */
export async function stopWorkerProcess(deps: WorkerShutdownDeps): Promise<void> {
  await teardownWithin(
    'runner stop',
    deps.stopRunner,
    deps.runnerStopTimeoutMs ?? RUNNER_STOP_TIMEOUT_MS,
    deps,
  );
  await teardownWithin(
    'pool close',
    deps.closePool,
    deps.poolCloseTimeoutMs ?? POOL_CLOSE_TIMEOUT_MS,
    deps,
  );
  deps.exit(0);
}
