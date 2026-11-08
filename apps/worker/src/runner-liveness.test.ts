import { describe, expect, it, vi } from 'vitest';
import { watchRunnerLiveness, type RunnerLivenessDeps } from './runner-liveness';

// A Graphile runner that dies after startup must take the process
// down (Docker restarts on exit, NOT on an unhealthy healthcheck), while a
// deliberate shutdown or a clean stop must not.

function makeDeps(overrides: Partial<RunnerLivenessDeps> = {}) {
  let resolveExited!: () => void;
  // Resolves once the fatal path finished (exit is its last step).
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  const deps = {
    isShuttingDown: vi.fn(() => false),
    logError: vi.fn(),
    stopHeartbeat: vi.fn(),
    closePool: vi.fn(async () => undefined),
    exit: vi.fn(() => resolveExited()),
    ...overrides,
  };
  return { deps, exited };
}

/** Let the promise's reaction callbacks run without relying on the fatal path. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('watchRunnerLiveness', () => {
  it('on fatal rejection: logs, stops the heartbeat, closes the pool, exits 1', async () => {
    const { deps, exited } = makeDeps();
    const boom = new Error('pool destroyed');
    watchRunnerLiveness(Promise.reject(boom), deps);
    await exited;

    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('fatal'), { err: boom });
    expect(deps.stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(deps.closePool).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('still exits 1 when closing the pool itself fails', async () => {
    const { deps, exited } = makeDeps({
      closePool: vi.fn(async () => {
        throw new Error('pool already gone');
      }),
    });
    watchRunnerLiveness(Promise.reject(new Error('fatal')), deps);
    await exited;

    expect(deps.stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('still exits 1 when the pool close NEVER settles (deadline wins)', async () => {
    // A wedged pool (checked-out clients that never return) must not turn "exit so
    // Docker restarts us" into a dead worker that never exits.
    const { deps, exited } = makeDeps({
      closePool: vi.fn(() => new Promise(() => undefined)),
      poolCloseTimeoutMs: 20,
    });
    watchRunnerLiveness(Promise.reject(new Error('fatal')), deps);
    await exited;

    expect(deps.stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(deps.logError).toHaveBeenCalledWith(
      expect.stringContaining('pool'),
      expect.objectContaining({ err: expect.any(Error) }),
    );
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('does nothing when the rejection happens during a deliberate shutdown', async () => {
    const { deps } = makeDeps({ isShuttingDown: vi.fn(() => true) });
    watchRunnerLiveness(Promise.reject(new Error('stop-induced')), deps);
    await settle();

    expect(deps.stopHeartbeat).not.toHaveBeenCalled();
    expect(deps.closePool).not.toHaveBeenCalled();
    expect(deps.exit).not.toHaveBeenCalled();
  });

  it('does nothing when the runner promise resolves (deliberate stop)', async () => {
    const { deps } = makeDeps();
    watchRunnerLiveness(Promise.resolve(), deps);
    await settle();

    expect(deps.logError).not.toHaveBeenCalled();
    expect(deps.stopHeartbeat).not.toHaveBeenCalled();
    expect(deps.exit).not.toHaveBeenCalled();
  });
});
