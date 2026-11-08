// Process-lifecycle helpers for the two long-lived Node processes (the web
// server and the worker).
//
// Teardown: every shutdown step talks to something that can wedge — a Postgres
// that stopped answering holds both Graphile's `stop()` and `pool.end()` open
// indefinitely — and waiting on one without a bound ends in the orchestrator's
// SIGKILL instead, which is strictly worse: in-flight work is cut anyway AND
// the locks the process held stay marked live until something reaps them. Each
// step therefore runs under its own deadline, and neither a failure nor an
// overrun may stop the exit.
//
// Process errors: with no listener, an un-`.catch`'d promise or a throw outside
// any request is a bare stderr stack the structured logs never see. Both are
// logged here; only the exception exits, because a process whose invariants an
// exception just broke cannot be trusted to keep serving, while a rejected
// promise leaves the rest of it intact.

import type { LogFields } from './logger';

export interface TeardownDeps {
  /** Injected so tests drive the deadline with fake timers. */
  wait: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

/**
 * Run one teardown step under a deadline. Never throws and never outlives
 * `timeoutMs`: a step that fails or overruns is logged under `label`, and the
 * caller carries on to the next step and, ultimately, to the exit.
 */
export async function teardownWithin(
  label: string,
  step: () => Promise<unknown>,
  timeoutMs: number,
  deps: TeardownDeps,
): Promise<void> {
  // Both racers resolve rather than reject, so whichever loses can settle late
  // without becoming an unhandled rejection in a process that is already exiting.
  const done = step().then(
    () => true,
    (error: unknown) => {
      deps.log(`${label} failed: ${String(error)}`);
      return true;
    },
  );
  const settled = await Promise.race([done, deps.wait(timeoutMs).then(() => false)]);
  if (!settled) deps.log(`${label} exceeded ${timeoutMs}ms; continuing`);
}

export interface ProcessErrorDeps {
  /** The app's structured logger, so the same redaction covers whatever threw. */
  logError: (message: string, fields: LogFields) => void;
  exit: (code: number) => void;
  /** Defaults to `process`; a fake emitter makes the wiring unit-testable. */
  emitter?: Pick<NodeJS.EventEmitter, 'on'>;
}

/**
 * Route process-level errors into the app's logger. A rejection is logged and
 * the process keeps serving; an exception is logged and the process exits
 * non-zero, which is what Node would have done anyway — minus the log line.
 */
export function installProcessErrorHandlers(deps: ProcessErrorDeps): void {
  const emitter = deps.emitter ?? process;
  emitter.on('unhandledRejection', (reason: unknown) => {
    deps.logError('unhandled promise rejection', { err: reason });
  });
  emitter.on('uncaughtException', (error: unknown) => {
    deps.logError('uncaught exception; exiting for restart', { err: error });
    deps.exit(1);
  });
}
