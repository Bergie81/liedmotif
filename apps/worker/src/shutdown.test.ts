import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stopWorkerProcess } from './shutdown';

// A deploy against a wedged Postgres must still end in `process.exit`: without a
// deadline the container is SIGKILLed instead, and the job locks this worker
// holds stay marked live until the next boot reaps them.

const realWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('stopWorkerProcess', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops the runner before closing the pool, then exits 0', async () => {
    const order: string[] = [];
    const deps = {
      stopRunner: vi.fn(async () => void order.push('runner')),
      closePool: vi.fn(async () => void order.push('pool')),
      wait: realWait,
      exit: vi.fn((code: number) => void order.push(`exit:${code}`)),
      log: vi.fn(),
    };

    await stopWorkerProcess(deps);

    expect(order).toEqual(['runner', 'pool', 'exit:0']);
    expect(deps.log).not.toHaveBeenCalled();
  });

  it('exits anyway when the runner stop never settles, and still closes the pool', async () => {
    const deps = {
      stopRunner: vi.fn(() => new Promise<void>(() => {})), // never settles
      closePool: vi.fn(async () => undefined),
      wait: realWait,
      exit: vi.fn(),
      log: vi.fn(),
      runnerStopTimeoutMs: 1_000,
      poolCloseTimeoutMs: 500,
    };

    const stopped = stopWorkerProcess(deps);
    await vi.advanceTimersByTimeAsync(1_000);
    await stopped;

    expect(deps.closePool).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('runner stop exceeded'));
  });

  it('exits anyway when the pool close hangs past its own deadline', async () => {
    const deps = {
      stopRunner: vi.fn(async () => undefined),
      closePool: vi.fn(() => new Promise<void>(() => {})), // never settles
      wait: realWait,
      exit: vi.fn(),
      log: vi.fn(),
      runnerStopTimeoutMs: 1_000,
      poolCloseTimeoutMs: 500,
    };

    const stopped = stopWorkerProcess(deps);
    await vi.advanceTimersByTimeAsync(500);
    await stopped;

    expect(deps.exit).toHaveBeenCalledWith(0);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('pool close exceeded'));
  });
});
