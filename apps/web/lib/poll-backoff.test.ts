import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollBackoffMs, pollWithBackoff } from './poll-backoff';

describe('pollBackoffMs', () => {
  const base = 5000;
  const max = 40_000;

  it('returns the normal cadence unchanged while there are no failures', () => {
    // The success path must be byte-for-byte the caller's normal interval — no
    // jitter, no growth — so perceived responsiveness is untouched.
    expect(pollBackoffMs({ failures: 0, baseMs: base, maxMs: max })).toBe(base);
    expect(pollBackoffMs({ failures: 0, baseMs: base, maxMs: max, jitterRatio: 0.5 })).toBe(base);
  });

  it('doubles from the base toward the cap as failures accumulate', () => {
    expect(pollBackoffMs({ failures: 1, baseMs: base, maxMs: max })).toBe(5000);
    expect(pollBackoffMs({ failures: 2, baseMs: base, maxMs: max })).toBe(10_000);
    expect(pollBackoffMs({ failures: 3, baseMs: base, maxMs: max })).toBe(20_000);
  });

  it('never exceeds the cap however long failures persist', () => {
    expect(pollBackoffMs({ failures: 4, baseMs: base, maxMs: max })).toBe(40_000);
    expect(pollBackoffMs({ failures: 20, baseMs: base, maxMs: max })).toBe(40_000);
  });

  it('keeps a jittered delay within (cap - jitter, cap] so the cap stays a ceiling', () => {
    // Jitter only ever subtracts, so a fleet of clients spreads out below the
    // cap and never above it. random()=0 → no shave; random()→1 → full shave.
    const capped = 20_000; // failures: 3
    expect(
      pollBackoffMs({ failures: 3, baseMs: base, maxMs: max, jitterRatio: 0.2, random: () => 0 }),
    ).toBe(capped);
    const shaved = pollBackoffMs({
      failures: 3,
      baseMs: base,
      maxMs: max,
      jitterRatio: 0.2,
      random: () => 0.999,
    });
    expect(shaved).toBeGreaterThanOrEqual(Math.round(capped * 0.8));
    expect(shaved).toBeLessThan(capped);
  });
});

describe('pollWithBackoff', () => {
  const BASE = 3000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('document', { visibilityState: 'visible' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('stretches the delay while reads keep failing and restores the cadence on recovery', async () => {
    let ok = false;
    const read = vi.fn(async () => ok);
    const stop = pollWithBackoff(BASE, read);

    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);

    // One failure still retries at roughly the normal cadence…
    await vi.advanceTimersByTimeAsync(BASE);
    expect(read).toHaveBeenCalledTimes(2);

    // …but a backend that stays down is not polled at full cadence: after the
    // second failure the next read is at least 1.6x the interval away.
    await vi.advanceTimersByTimeAsync(BASE);
    expect(read).toHaveBeenCalledTimes(2);

    ok = true;
    await vi.advanceTimersByTimeAsync(BASE);
    expect(read).toHaveBeenCalledTimes(3);

    // Recovered: back to the exact interval, no jitter on the success path.
    await vi.advanceTimersByTimeAsync(BASE);
    expect(read).toHaveBeenCalledTimes(4);
    stop();
  });

  it('treats a thrown read as a failure instead of ending the poll', async () => {
    let throwing = true;
    const read = vi.fn(async () => {
      if (throwing) throw new Error('offline');
      return true;
    });
    const stop = pollWithBackoff(BASE, read);

    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);

    // A surface whose poll died on one thrown read would never recover.
    throwing = false;
    await vi.advanceTimersByTimeAsync(BASE);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });

  it('aborts the in-flight read on stop and schedules nothing further', async () => {
    let signal: AbortSignal | undefined;
    const read = vi.fn((readSignal: AbortSignal) => {
      signal = readSignal;
      return new Promise<boolean>(() => {}); // still in flight when stopped
    });
    const stop = pollWithBackoff(BASE, read);
    await vi.advanceTimersByTimeAsync(0);

    stop();
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('skips reads while the tab is hidden without losing the schedule', async () => {
    const read = vi.fn(async () => true);
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    const stop = pollWithBackoff(BASE, read);

    await vi.advanceTimersByTimeAsync(BASE * 3);
    expect(read).not.toHaveBeenCalled();

    vi.stubGlobal('document', { visibilityState: 'visible' });
    await vi.advanceTimersByTimeAsync(BASE);
    expect(read).toHaveBeenCalledTimes(1);
    stop();
  });
});
