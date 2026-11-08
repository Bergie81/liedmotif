// Fatal-runner liveness policy. The worker's Docker healthcheck reads the
// heartbeat file, but plain Docker Compose never restarts a container on health
// alone — only `restart: unless-stopped` on process exit does. So a Graphile
// runner that dies AFTER starting (fatal `runner.promise` rejection) must take
// the process down: staying up heartbeat-only would keep the container "healthy"
// while no job ever runs again (paid generations silently stall).

export interface RunnerLivenessDeps {
  /** True while a deliberate SIGTERM/SIGINT shutdown is in flight. */
  isShuttingDown: () => boolean;
  logError: (message: string, context: Record<string, unknown>) => void;
  /** Clear the heartbeat interval so the healthcheck goes stale immediately. */
  stopHeartbeat: () => void;
  /** Best-effort pool close; a failure or hang here must not block the exit. */
  closePool: () => Promise<unknown>;
  exit: (code: number) => void;
  /** Deadline for the best-effort pool close (tests use a tiny value). */
  poolCloseTimeoutMs?: number;
}

/**
 * The fatal path exists to EXIT; the pool close is a courtesy. A runner that died
 * because `pg` is in a bad pool/client state can leave `pool.end()` waiting on
 * checked-out clients forever — without a deadline that would recreate the very
 * "dead worker that never restarts" failure this module fixes.
 */
const DEFAULT_POOL_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Watch the runner's lifetime promise: it resolves on a deliberate `stop()` and
 * rejects on a fatal internal error. Only a rejection OUTSIDE shutdown is fatal —
 * then the heartbeat stops, the pool closes best-effort (time-bounded), and the
 * process exits non-zero so Docker's restart policy brings up a fresh worker.
 */
export function watchRunnerLiveness(promise: Promise<unknown>, deps: RunnerLivenessDeps): void {
  promise.then(
    () => undefined,
    async (err: unknown) => {
      if (deps.isShuttingDown()) return;
      deps.logError('worker runner exited fatally; exiting so Docker restarts the worker', {
        err,
      });
      deps.stopHeartbeat();
      let deadline: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          deps.closePool(),
          new Promise((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(new Error('database pool close timed out')),
              deps.poolCloseTimeoutMs ?? DEFAULT_POOL_CLOSE_TIMEOUT_MS,
            );
          }),
        ]);
      } catch (poolErr) {
        deps.logError('error closing database pool after fatal runner exit', { err: poolErr });
      } finally {
        clearTimeout(deadline);
      }
      deps.exit(1);
    },
  );
}
