// Capped exponential backoff for failing client polls — the shared shape behind
// the queue poller's failure tier and the settings/sleeve polls — plus the loop
// that runs a status poll on it. On success the caller's normal cadence is
// returned unchanged; only failures grow the delay toward the cap, optionally
// shaved by jitter.

/** Default cap and jitter for a settings/sleeve poll backing off on failure. */
export const FAILURE_BACKOFF_MAX_MS = 60_000;
export const FAILURE_BACKOFF_JITTER = 0.2;

/**
 * Delay before the next poll given `failures` CONSECUTIVE failures. `failures`
 * of 0 means the last poll succeeded, so the caller's normal cadence (`baseMs`)
 * is returned unchanged — the success path is untouched. From the first failure
 * the delay doubles from `baseMs` toward `maxMs` and holds there. When
 * `jitterRatio` is set, failure delays are shaved by up to that fraction (never
 * added to), so many clients spread out below the cap while `maxMs` stays a hard
 * ceiling. `random` is injectable for deterministic tests.
 */
export function pollBackoffMs(args: {
  failures: number;
  baseMs: number;
  maxMs: number;
  jitterRatio?: number;
  random?: () => number;
}): number {
  if (args.failures <= 0) return args.baseMs;
  const capped = Math.min(args.baseMs * 2 ** (args.failures - 1), args.maxMs);
  const jitterRatio = args.jitterRatio ?? 0;
  if (jitterRatio <= 0) return capped;
  const random = args.random ?? Math.random;
  return Math.round(capped * (1 - jitterRatio * random()));
}

/**
 * Run `read` every `intervalMs` while the tab is visible, stretching the delay
 * per {@link pollBackoffMs} for as long as reads answer `false` and snapping
 * back to `intervalMs` on the first success. Delays are completion-scheduled, so
 * a slow backend can never stack overlapping reads, and a hidden tab skips its
 * read entirely — a background surface paints nothing. Returns the stop
 * function: it aborts the in-flight read and cancels the next one.
 */
export function pollWithBackoff(
  intervalMs: number,
  read: (signal: AbortSignal) => Promise<boolean>,
): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;

  const schedule = () => {
    timer = setTimeout(
      () => void tick(),
      pollBackoffMs({
        failures,
        baseMs: intervalMs,
        maxMs: FAILURE_BACKOFF_MAX_MS,
        jitterRatio: FAILURE_BACKOFF_JITTER,
      }),
    );
  };

  const tick = async () => {
    if (controller.signal.aborted) return;
    if (document.visibilityState !== 'hidden') {
      // A read that throws is a failed read like any other: swallowing it here
      // is what keeps one bad response from ending the poll for good.
      const ok = await read(controller.signal).catch(() => false);
      if (controller.signal.aborted) return;
      failures = ok ? 0 : failures + 1;
    }
    schedule();
  };

  void tick();

  return () => {
    controller.abort();
    if (timer) clearTimeout(timer);
  };
}
