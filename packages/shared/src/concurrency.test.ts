import { describe, expect, it } from 'vitest';
import { mapWithConcurrency, Semaphore, SemaphoreBusyError } from './concurrency';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('mapWithConcurrency', () => {
  it('preserves input order in the results', async () => {
    const items = [30, 10, 20, 0, 40];
    const results = await mapWithConcurrency(items, 2, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(results).toEqual(items);
  });

  it('never runs more than the cap concurrently', async () => {
    const gates = Array.from({ length: 10 }, () => deferred<void>());
    let running = 0;
    let peak = 0;
    const done = mapWithConcurrency(gates, 3, async (gate) => {
      running += 1;
      peak = Math.max(peak, running);
      await gate.promise;
      running -= 1;
    });
    // Let the pool start; only the first `cap` tasks may be in flight.
    await new Promise((resolve) => setImmediate(resolve));
    expect(running).toBe(3);
    for (const gate of gates) gate.resolve();
    await done;
    expect(peak).toBe(3);
  });

  it('handles an empty input and a cap above the item count', async () => {
    expect(await mapWithConcurrency([], 8, async (n: number) => n)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 8, async (n) => n * 2)).toEqual([2, 4]);
  });

  it('rejects when a task rejects', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});

describe('Semaphore', () => {
  it('admits at most `slots` tasks at once and runs the rest afterwards', async () => {
    const semaphore = new Semaphore(2);
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    let running = 0;
    let peak = 0;
    const done = gates.map((gate) =>
      semaphore.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
        return 'ok';
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(running).toBe(2);
    for (const gate of gates) gate.resolve();
    expect(await Promise.all(done)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(peak).toBe(2);
  });

  it('releases the slot when a task throws', async () => {
    const semaphore = new Semaphore(1);
    await expect(
      semaphore.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await semaphore.run(async () => 'still works')).toBe('still works');
  });

  // A queue with no ceiling is not backpressure: every caller in a burst stays
  // alive holding whatever it already read.
  it('refuses a caller past the waiter cap, and still serves the ones in the queue', async () => {
    const semaphore = new Semaphore(1, { maxWaiting: 1 });
    const gate = deferred<void>();
    const held = semaphore.run(() => gate.promise);
    const queued = semaphore.run(async () => 'queued');

    await expect(semaphore.run(async () => 'refused')).rejects.toBeInstanceOf(SemaphoreBusyError);

    gate.resolve();
    await held;
    expect(await queued).toBe('queued');
  });

  it('refuses a caller that waited too long, leaving the slot free for the next one', async () => {
    const semaphore = new Semaphore(1, { waitTimeoutMs: 5 });
    const gate = deferred<void>();
    const held = semaphore.run(() => gate.promise);

    await expect(semaphore.run(async () => 'late')).rejects.toBeInstanceOf(SemaphoreBusyError);

    gate.resolve();
    await held;
    // The refused caller left the queue; the released slot is not handed to it.
    expect(await semaphore.run(async () => 'ok')).toBe('ok');
  });
});
