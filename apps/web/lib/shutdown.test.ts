import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainWebProcess, installWebSignalHandlers, resolveShutdownGraceMs } from './shutdown';

const realWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('drainWebProcess', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits the in-flight grace, then closes the pool, then exits — in that order', async () => {
    const order: string[] = [];
    let releasePool!: () => void;
    const closePool = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releasePool = () => {
            order.push('pool');
            resolve();
          };
        }),
    );
    const exit = vi.fn((code: number) => void order.push(`exit:${code}`));

    const drained = drainWebProcess({
      graceMs: 15_000,
      poolCloseTimeoutMs: 5_000,
      wait: realWait,
      closePool,
      exit,
      log: () => {},
    });

    // The pool must not be touched until the whole grace window has elapsed —
    // that window is what lets an in-flight audio stream finish.
    await vi.advanceTimersByTimeAsync(14_999);
    expect(closePool).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(closePool).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    releasePool();
    await drained;
    expect(order).toEqual(['pool', 'exit:0']);
  });

  it('still exits if the pool close hangs past its timeout', async () => {
    const closePool = vi.fn(() => new Promise<void>(() => {})); // never resolves
    const exit = vi.fn();
    const log = vi.fn();

    const drained = drainWebProcess({
      graceMs: 15_000,
      poolCloseTimeoutMs: 5_000,
      wait: realWait,
      closePool,
      exit,
      log,
    });

    await vi.advanceTimersByTimeAsync(15_000); // grace elapses, pool close starts
    expect(closePool).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000); // pool-close timeout fires
    await drained;
    expect(exit).toHaveBeenCalledWith(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('pool close'));
  });
});

describe('installWebSignalHandlers', () => {
  it('drains once; a second signal forces an immediate exit instead of a second drain', () => {
    const emitter = new EventEmitter();
    const drain = vi.fn(() => Promise.resolve());
    const forceExit = vi.fn();
    installWebSignalHandlers({ emitter, drain, forceExit, log: () => {} });

    emitter.emit('SIGTERM');
    expect(drain).toHaveBeenCalledTimes(1);
    expect(forceExit).not.toHaveBeenCalled();

    emitter.emit('SIGINT');
    expect(drain).toHaveBeenCalledTimes(1);
    expect(forceExit).toHaveBeenCalledWith(1);
  });
});

describe('resolveShutdownGraceMs', () => {
  it('parses a valid override', () => {
    expect(resolveShutdownGraceMs({ WEB_SHUTDOWN_GRACE_MS: '30000' })).toBe(30_000);
  });

  it('falls back to a positive default when unset', () => {
    expect(resolveShutdownGraceMs({})).toBeGreaterThan(0);
  });

  it('throws on a non-numeric or negative value so a typo fails the deploy', () => {
    expect(() => resolveShutdownGraceMs({ WEB_SHUTDOWN_GRACE_MS: 'soon' })).toThrow();
    expect(() => resolveShutdownGraceMs({ WEB_SHUTDOWN_GRACE_MS: '-1' })).toThrow();
  });
});
