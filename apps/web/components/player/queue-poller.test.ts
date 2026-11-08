import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createQueuePoller,
  resolveQueuePollDelay,
  QUEUE_POLL_NORMAL_MS,
  QUEUE_POLL_QUIET_MS,
  QUEUE_POLL_URGENT_MS,
  type QueuePollSignals,
} from './queue-poller';

function signals(overrides: Partial<QueuePollSignals> = {}): QueuePollSignals {
  return {
    sessionStatus: 'active',
    generationCanChangeQueue: true,
    hasPendingGeneration: false,
    switchPending: false,
    hasPlayableFreshTrack: true,
    ...overrides,
  };
}

describe('resolveQueuePollDelay', () => {
  const base = { isPlaying: false, hidden: false, consecutiveFailures: 0 };

  it('is urgent while generation is pending and nothing is playable (cold start)', () => {
    expect(
      resolveQueuePollDelay({
        ...base,
        signals: signals({ hasPendingGeneration: true, hasPlayableFreshTrack: false }),
      }),
    ).toBe(QUEUE_POLL_URGENT_MS);
  });

  it('is urgent while a switch-now Change Vibe is armed', () => {
    expect(resolveQueuePollDelay({ ...base, signals: signals({ switchPending: true }) })).toBe(
      QUEUE_POLL_URGENT_MS,
    );
  });

  it('is normal during active playback and while generation can change the Queue', () => {
    expect(resolveQueuePollDelay({ ...base, isPlaying: true, signals: signals() })).toBe(
      QUEUE_POLL_NORMAL_MS,
    );
    expect(resolveQueuePollDelay({ ...base, signals: signals() })).toBe(QUEUE_POLL_NORMAL_MS);
  });

  it('is quiet for a stopped Session and for an idle no-new-tracks Session', () => {
    expect(resolveQueuePollDelay({ ...base, signals: signals({ sessionStatus: 'stopped' }) })).toBe(
      QUEUE_POLL_QUIET_MS,
    );
    expect(
      resolveQueuePollDelay({ ...base, signals: signals({ generationCanChangeQueue: false }) }),
    ).toBe(QUEUE_POLL_QUIET_MS);
  });

  it('keeps playing at normal even when the Session itself went quiet', () => {
    expect(
      resolveQueuePollDelay({
        ...base,
        isPlaying: true,
        signals: signals({ sessionStatus: 'stopped' }),
      }),
    ).toBe(QUEUE_POLL_NORMAL_MS);
  });

  it('treats a hidden tab as quiet ONLY when no audio is playing', () => {
    expect(
      resolveQueuePollDelay({
        ...base,
        hidden: true,
        signals: signals({ hasPendingGeneration: true, hasPlayableFreshTrack: false }),
      }),
    ).toBe(QUEUE_POLL_QUIET_MS);
    expect(
      resolveQueuePollDelay({ ...base, hidden: true, isPlaying: true, signals: signals() }),
    ).toBe(QUEUE_POLL_NORMAL_MS);
  });

  it('backs off exponentially on failures up to the quiet ceiling', () => {
    expect(resolveQueuePollDelay({ ...base, signals: null, consecutiveFailures: 1 })).toBe(4000);
    expect(resolveQueuePollDelay({ ...base, signals: null, consecutiveFailures: 2 })).toBe(8000);
    expect(resolveQueuePollDelay({ ...base, signals: null, consecutiveFailures: 3 })).toBe(
      QUEUE_POLL_QUIET_MS,
    );
  });

  it('stays at normal before the first response', () => {
    expect(resolveQueuePollDelay({ ...base, signals: null })).toBe(QUEUE_POLL_NORMAL_MS);
  });
});

describe('createQueuePoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makePoller(overrides: {
    results?: Array<{ ok: true; signals: QueuePollSignals } | { ok: false }>;
    isPlaying?: () => boolean;
    isHidden?: () => boolean;
    resolveManually?: boolean;
  }) {
    const calls: AbortSignal[] = [];
    let release: (() => void) | undefined;
    const results = overrides.results ?? [];
    const poll = vi.fn(async (signal: AbortSignal) => {
      calls.push(signal);
      if (overrides.resolveManually) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return (
        results[Math.min(calls.length - 1, results.length - 1)] ?? {
          ok: true as const,
          signals: signals(),
        }
      );
    });
    const poller = createQueuePoller({
      poll,
      isPlaying: overrides.isPlaying ?? (() => false),
      isHidden: overrides.isHidden ?? (() => false),
    });
    return { poller, poll, calls, releaseInFlight: () => release?.() };
  }

  it('polls immediately on start, then reschedules from each completion', async () => {
    const { poller, poll } = makePoller({
      results: [{ ok: true, signals: signals() }],
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(QUEUE_POLL_NORMAL_MS);
    expect(poll).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it('drops to urgent cadence when the response says the player is waiting', async () => {
    const { poller, poll } = makePoller({
      results: [
        {
          ok: true,
          signals: signals({ hasPendingGeneration: true, hasPlayableFreshTrack: false }),
        },
      ],
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(QUEUE_POLL_URGENT_MS);
    expect(poll).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it('rises to quiet cadence for a stopped Session', async () => {
    const { poller, poll } = makePoller({
      results: [{ ok: true, signals: signals({ sessionStatus: 'stopped' }) }],
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(QUEUE_POLL_NORMAL_MS);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(QUEUE_POLL_QUIET_MS - QUEUE_POLL_NORMAL_MS);
    expect(poll).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it('NEVER overlaps requests: a due tick while one is in flight is absorbed', async () => {
    const { poller, poll, releaseInFlight } = makePoller({ resolveManually: true });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);
    // Even far past several normal intervals, no second request starts.
    await vi.advanceTimersByTimeAsync(QUEUE_POLL_NORMAL_MS * 5);
    expect(poll).toHaveBeenCalledTimes(1);
    releaseInFlight();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(QUEUE_POLL_NORMAL_MS);
    expect(poll).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it('pollNow polls immediately, and during a flight re-polls right after it', async () => {
    const { poller, poll, releaseInFlight } = makePoller({ resolveManually: true });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);
    poller.pollNow(); // absorbed into a trailing re-poll
    releaseInFlight();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(2);
    releaseInFlight();
    poller.dispose();
  });

  it('backs off on failures and recovers on the next success', async () => {
    const { poller, poll } = makePoller({
      results: [{ ok: false }, { ok: false }, { ok: true, signals: signals() }],
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1); // failed
    await vi.advanceTimersByTimeAsync(4000);
    expect(poll).toHaveBeenCalledTimes(2); // failed again
    await vi.advanceTimersByTimeAsync(8000);
    expect(poll).toHaveBeenCalledTimes(3); // success
    await vi.advanceTimersByTimeAsync(QUEUE_POLL_NORMAL_MS);
    expect(poll).toHaveBeenCalledTimes(4);
    poller.dispose();
  });

  it('a throwing poll counts as a failure instead of killing the loop', async () => {
    let first = true;
    const poll = vi.fn(async () => {
      if (first) {
        first = false;
        throw new Error('network down');
      }
      return { ok: true as const, signals: signals() };
    });
    const poller = createQueuePoller({ poll, isPlaying: () => false, isHidden: () => false });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(poll).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it('dispose aborts the in-flight request and stops all scheduling', async () => {
    const { poller, poll, calls, releaseInFlight } = makePoller({ resolveManually: true });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);
    poller.dispose();
    expect(calls[0]!.aborted).toBe(true);
    releaseInFlight();
    await vi.advanceTimersByTimeAsync(QUEUE_POLL_QUIET_MS * 3);
    expect(poll).toHaveBeenCalledTimes(1);
    poller.pollNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
