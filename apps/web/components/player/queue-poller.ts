// Adaptive Session Queue polling (React-free so the cadence machine is unit
// testable). Delays are completion-scheduled — the next request is timed from
// the previous one finishing, so at most one request is ever in flight — and
// tiered by what the poll can actually observe:
//
// - urgent: nothing playable while generation is pending, or a switch-now
//   Change Vibe is armed — the player is waiting on the server;
// - normal: playback is running or generation can still change the Queue;
// - quiet:  a stopped/idle Session, or a hidden tab with no audio playing.
//
// Hidden playback stays at normal: background audio is not idle. Failures back
// off exponentially from the normal tier up to the quiet ceiling.

import { pollBackoffMs } from '@/lib/poll-backoff';

export const QUEUE_POLL_URGENT_MS = 1000;
export const QUEUE_POLL_NORMAL_MS = 4000;
export const QUEUE_POLL_QUIET_MS = 15000;

/** The per-response signals the cadence is derived from. */
export interface QueuePollSignals {
  sessionStatus: 'active' | 'stopped';
  /** `'ok'` is the only status under which new Tracks can still arrive. */
  generationCanChangeQueue: boolean;
  hasPendingGeneration: boolean;
  switchPending: boolean;
  /** A playable Track the listener has NOT played through yet. Played items
   * stay in the Queue forever, so "anything playable" would mask the
   * mid-session waits (reroll near the Queue's end) urgency exists for. */
  hasPlayableFreshTrack: boolean;
}

export interface QueuePollerDeps {
  /** Perform one poll: fetch, apply the snapshot, and return the signals the
   * next delay is computed from (`ok: false` = transport/API failure). */
  poll: (signal: AbortSignal) => Promise<{ ok: true; signals: QueuePollSignals } | { ok: false }>;
  isPlaying: () => boolean;
  isHidden: () => boolean;
}

export interface QueuePoller {
  /** Begin with an immediate poll. */
  start: () => void;
  /** Poll as soon as possible (mutation wake-up, reconnect, tab visible). An
   * in-flight poll absorbs the request by re-polling immediately after. */
  pollNow: () => void;
  /** Abort any in-flight request and stop scheduling. */
  dispose: () => void;
}

export function resolveQueuePollDelay(args: {
  signals: QueuePollSignals | null;
  isPlaying: boolean;
  hidden: boolean;
  consecutiveFailures: number;
}): number {
  if (args.consecutiveFailures > 0) {
    return pollBackoffMs({
      failures: args.consecutiveFailures,
      baseMs: QUEUE_POLL_NORMAL_MS,
      maxMs: QUEUE_POLL_QUIET_MS,
    });
  }
  if (args.hidden && !args.isPlaying) return QUEUE_POLL_QUIET_MS;
  const signals = args.signals;
  // No response applied yet (start() already polls immediately): stay at
  // normal until the first answer tells us better.
  if (!signals) return QUEUE_POLL_NORMAL_MS;
  if (signals.sessionStatus === 'active') {
    const waitingOnServer =
      signals.switchPending || (signals.hasPendingGeneration && !signals.hasPlayableFreshTrack);
    if (waitingOnServer) return QUEUE_POLL_URGENT_MS;
    if (signals.generationCanChangeQueue) return QUEUE_POLL_NORMAL_MS;
  }
  return args.isPlaying ? QUEUE_POLL_NORMAL_MS : QUEUE_POLL_QUIET_MS;
}

export function createQueuePoller(deps: QueuePollerDeps): QueuePoller {
  let disposed = false;
  let inFlight = false;
  let pollAgainAfterFlight = false;
  let consecutiveFailures = 0;
  let signals: QueuePollSignals | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: AbortController | undefined;

  const scheduleNext = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      run,
      resolveQueuePollDelay({
        signals,
        isPlaying: deps.isPlaying(),
        hidden: deps.isHidden(),
        consecutiveFailures,
      }),
    );
  };

  const run = async () => {
    if (disposed || inFlight) return;
    inFlight = true;
    abort = new AbortController();
    let result: Awaited<ReturnType<QueuePollerDeps['poll']>>;
    try {
      result = await deps.poll(abort.signal);
    } catch {
      result = { ok: false };
    }
    inFlight = false;
    if (disposed) return;
    if (result.ok) {
      consecutiveFailures = 0;
      signals = result.signals;
    } else {
      consecutiveFailures += 1;
    }
    if (pollAgainAfterFlight) {
      pollAgainAfterFlight = false;
      void run();
      return;
    }
    scheduleNext();
  };

  return {
    start: () => void run(),
    pollNow: () => {
      if (disposed) return;
      if (inFlight) {
        pollAgainAfterFlight = true;
        return;
      }
      if (timer) clearTimeout(timer);
      void run();
    },
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      abort?.abort();
    },
  };
}
