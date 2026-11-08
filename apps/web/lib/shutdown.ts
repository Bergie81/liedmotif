// Graceful shutdown for the Next standalone web process.
//
// Next's default SIGTERM handler exits immediately: in-flight audio streams and
// zip downloads are cut mid-byte on every deploy and the pg pool never drains.
// With `NEXT_MANUAL_SIG_HANDLE=1` (set on the web image) Next installs no signal
// handler, so `instrumentation.ts` wires these instead. The drain gives in-flight
// responses a bounded grace to finish — the HTTP server keeps serving because we
// have not exited; stopping NEW connections is the orchestrator's job (Docker
// stops the container, Caddy stops routing) — then closes the pool and exits. The
// grace is sized under the compose `stop_grace_period` so Docker never SIGKILLs
// mid-drain.
//
// There is no vitest seam for real process signals; the drain helper and the
// signal wiring below are unit-tested with injected deps, and the end-to-end
// behavior is verified with the scripted manual check in `docker/README.md`
// ("Graceful shutdown (web)").

import { teardownWithin, type TeardownDeps } from '@liedmotif/shared';

/** In-flight grace when `WEB_SHUTDOWN_GRACE_MS` is unset. Must stay under the
 *  web service's compose `stop_grace_period` (with pool-close headroom). */
const DEFAULT_SHUTDOWN_GRACE_MS = 15_000;

/** Ceiling on the pool close itself, so one hung connection can't outlast the grace. */
const DEFAULT_POOL_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Resolve the in-flight grace from the environment. A malformed value fails the
 * boot loudly (mirroring the other checks in `instrumentation.ts`) rather than
 * silently becoming `NaN`, which `setTimeout` would treat as zero grace.
 */
export function resolveShutdownGraceMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.WEB_SHUTDOWN_GRACE_MS;
  if (raw == null || raw === '') return DEFAULT_SHUTDOWN_GRACE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `WEB_SHUTDOWN_GRACE_MS must be a non-negative number of milliseconds; got ${JSON.stringify(raw)}`,
    );
  }
  return Math.floor(parsed);
}

export interface DrainDeps extends TeardownDeps {
  graceMs: number;
  poolCloseTimeoutMs?: number;
  closePool: () => Promise<void>;
  exit: (code: number) => void;
}

/**
 * Bounded in-flight grace, then a time-boxed pool close, then exit. Never throws:
 * a pool-close error or timeout is logged and the process still exits, so a stuck
 * pool can't leave the container hanging until Docker SIGKILLs it.
 */
export async function drainWebProcess(deps: DrainDeps): Promise<void> {
  deps.log(`draining: allowing in-flight responses up to ${deps.graceMs}ms`);
  await deps.wait(deps.graceMs);
  await teardownWithin(
    'pool close',
    deps.closePool,
    deps.poolCloseTimeoutMs ?? DEFAULT_POOL_CLOSE_TIMEOUT_MS,
    deps,
  );
  deps.exit(0);
}

export interface SignalDeps {
  /** Defaults to `process`; a fake emitter makes the wiring unit-testable. */
  emitter?: Pick<NodeJS.EventEmitter, 'on'>;
  drain: () => Promise<void> | void;
  forceExit: (code: number) => void;
  log: (message: string) => void;
}

/**
 * Wire SIGTERM/SIGINT to a single drain. Idempotent: the first signal starts the
 * drain; a second (an impatient operator, or Docker escalating) forces an
 * immediate non-zero exit rather than stacking a second drain.
 */
export function installWebSignalHandlers(deps: SignalDeps): void {
  const emitter = deps.emitter ?? process;
  let draining = false;
  const handle = (signal: string): void => {
    if (draining) {
      deps.log(`received ${signal} during drain; forcing exit`);
      deps.forceExit(1);
      return;
    }
    draining = true;
    deps.log(`received ${signal}; starting graceful shutdown`);
    void Promise.resolve(deps.drain());
  };
  emitter.on('SIGTERM', () => handle('SIGTERM'));
  emitter.on('SIGINT', () => handle('SIGINT'));
}
