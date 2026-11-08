// Bounded fan-out for I/O batches (storage stat passes, tag probes, sweep
// enqueues): unbounded `Promise.all` maps turn a big batch into hundreds of
// simultaneous requests — a rate-limit hazard on S3 and a memory spike locally.

/**
 * A `Semaphore` refusal: no slot, and no room (or no time) left to wait for
 * one. Callers translate it into whatever "come back shortly" means on their
 * surface; it is never a server fault.
 */
export class SemaphoreBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemaphoreBusyError';
  }
}

export interface SemaphoreOptions {
  /**
   * How many callers may WAIT for a slot. Past it `run` rejects instead of
   * growing the queue — an unbounded queue is not backpressure: every request
   * in a burst stays alive holding whatever it already read, so the bound on
   * concurrent WORK becomes no bound at all on concurrent memory.
   */
  maxWaiting?: number;
  /** How long a caller may wait before `run` rejects. */
  waitTimeoutMs?: number;
}

/** A caller parked until a slot frees up, or until its own timer refuses it. */
interface Waiter {
  resume: () => void;
  refuse: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * A counting semaphore for long-lived callers that admit work one task at a
 * time (request handlers, pollers) rather than mapping over a batch: at most
 * `slots` tasks run concurrently, the rest queue in arrival order.
 *
 * Unbounded by default, which is right for a caller that owns its own arrival
 * rate (a poller, a fan-out over a known batch). A caller whose arrival rate is
 * the internet's — anything reached from a request handler — passes
 * `maxWaiting`/`waitTimeoutMs` and turns saturation into a refusal.
 */
export class Semaphore {
  private readonly waiters: Waiter[] = [];
  private active = 0;
  private readonly maxWaiting: number;
  private readonly waitTimeoutMs: number | null;

  constructor(
    private readonly slots: number,
    options: SemaphoreOptions = {},
  ) {
    this.maxWaiting = options.maxWaiting ?? Number.POSITIVE_INFINITY;
    this.waitTimeoutMs = options.waitTimeoutMs ?? null;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.slots) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxWaiting) {
      return Promise.reject(new SemaphoreBusyError('Too many callers are already waiting.'));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resume: resolve, refuse: reject, timer: null };
      if (this.waitTimeoutMs !== null) {
        // Leaving the queue on timeout is what keeps `release` simple: every
        // waiter still in the array is one that can still be resumed.
        waiter.timer = setTimeout(() => {
          const at = this.waiters.indexOf(waiter);
          if (at !== -1) this.waiters.splice(at, 1);
          waiter.refuse(new SemaphoreBusyError('Timed out waiting for a slot.'));
        }, this.waitTimeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    // The releasing task hands its slot to the waiter directly (`active`
    // unchanged), so a newcomer can never slip in between release and resume.
    const next = this.waiters.shift();
    if (!next) {
      this.active -= 1;
      return;
    }
    if (next.timer) clearTimeout(next.timer);
    next.resume();
  }
}

/**
 * `items.map(task)` with at most `limit` tasks in flight; results keep input
 * order. Rejects on the first task failure, like `Promise.all` — callers that
 * tolerate per-item failure catch inside `task`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
