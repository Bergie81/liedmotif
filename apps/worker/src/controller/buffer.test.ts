import { describe, expect, it } from 'vitest';
import {
  BLOCK_SIGNAL_COOLDOWNS_MS,
  decideBufferAction,
  isFailedPaidBatch,
  isListenerActive,
  LISTENER_ACTIVE_WINDOW_MS,
  mapProviderBlockSignal,
  PHANTOM_SUBMIT_MAX_AGE_MS,
  restartCountsAsListener,
  type BufferDecisionInput,
} from './buffer';

const within = { withinLimits: true } as const;
const overDay = { withinLimits: false, window: 'day', scope: 'instance' } as const;

const base: BufferDecisionInput = {
  sessionMode: 'keep_going',
  readyAheadCount: 0,
  inFlightAheadCount: 0,
  bufferAheadTracks: 3,
  // Above the ready-ahead range, so the cap binds only where a test sets it.
  maxQueuedTracks: 10,
  hasEverGenerated: true,
  hasCurrentRevisionGenerated: true,
  rerollPending: false,
  ownReadyTrackCount: 5,
  manualGenerationOnly: false,
  hasConcurrencySlot: true,
  costLimit: within,
  providerSignal: null,
  listenerActive: true,
  loopHeld: false,
  stuck: false,
  retryRequested: false,
};

describe('decideBufferAction', () => {
  it('generates to top up when below the low watermark with budget + a slot', () => {
    expect(decideBufferAction(base)).toEqual({ action: 'generate', generationStatus: 'ok' });
  });

  it('enters Session Repeat (repeat_cost_limit) when the cost limit is hit', () => {
    expect(decideBufferAction({ ...base, costLimit: overDay })).toEqual({
      action: 'session_repeat',
      generationStatus: 'repeat_cost_limit',
      costLimitScope: 'instance',
      costLimitWindow: 'day',
    });
  });

  it('cost limit takes precedence over a provider block', () => {
    expect(
      decideBufferAction({ ...base, costLimit: overDay, providerSignal: 'provider_error' }),
    ).toEqual({
      action: 'session_repeat',
      generationStatus: 'repeat_cost_limit',
      costLimitScope: 'instance',
      costLimitWindow: 'day',
    });
  });

  it('surfaces a provider block (keep playing ready tracks, no generation)', () => {
    for (const signal of [
      'provider_credits',
      'provider_rate_limited',
      'worker_stalled',
      'provider_error',
    ] as const) {
      expect(decideBufferAction({ ...base, providerSignal: signal })).toEqual({
        action: 'noop',
        generationStatus: signal,
      });
    }
  });

  it('voluntary Repeat loops the Session’s own tracks without generating (status ok)', () => {
    expect(decideBufferAction({ ...base, sessionMode: 'repeat', ownReadyTrackCount: 3 })).toEqual({
      action: 'voluntary_repeat',
      generationStatus: 'ok',
    });
  });

  it('voluntary Repeat never tops up — it loops whatever the Session already has', () => {
    // Repeat is "Play existing Tracks": even a single own track forms the loop;
    // there is no target the mode fills toward.
    expect(decideBufferAction({ ...base, sessionMode: 'repeat', ownReadyTrackCount: 1 })).toEqual({
      action: 'voluntary_repeat',
      generationStatus: 'ok',
    });
  });

  it('never auto-generates under manual-only', () => {
    expect(decideBufferAction({ ...base, manualGenerationOnly: true })).toEqual({
      action: 'noop',
      generationStatus: 'ok',
    });
  });

  it('does nothing while the buffer is adequate (at/above the low watermark)', () => {
    expect(decideBufferAction({ ...base, readyAheadCount: 2 })).toEqual({
      action: 'noop',
      generationStatus: 'ok',
    });
  });

  it('counts in-flight provider work toward the watermark (no double-submit)', () => {
    // No ready tracks yet, but an in-flight provider job already covers the
    // watermark — a concurrent sweep must not submit a second paid job.
    expect(decideBufferAction({ ...base, readyAheadCount: 0, inFlightAheadCount: 2 })).toEqual({
      action: 'noop',
      generationStatus: 'ok',
    });
  });

  it('still tops up when ready + in-flight work is below the watermark', () => {
    expect(decideBufferAction({ ...base, readyAheadCount: 0, inFlightAheadCount: 1 })).toEqual({
      action: 'generate',
      generationStatus: 'ok',
    });
  });

  it('waits (does not generate) when no concurrency slot is free', () => {
    expect(decideBufferAction({ ...base, hasConcurrencySlot: false })).toEqual({
      action: 'wait',
      generationStatus: 'ok',
    });
  });
});

describe('armed vibe switch (switch-now Change Vibe)', () => {
  // An armed switch reaches this policy with revision-scoped Queue supply and
  // no request for the current Style Snapshot revision. The existing Session
  // history does not mask the new vibe's initial fill.
  const armedSwitch = { ...base, hasCurrentRevisionGenerated: false };

  it('generates the new vibe even in Repeat mode (its own initial fill)', () => {
    expect(decideBufferAction({ ...armedSwitch, sessionMode: 'repeat' })).toEqual({
      action: 'generate',
      generationStatus: 'ok',
    });
  });

  it('does not double-submit once the new vibe is in flight', () => {
    expect(
      decideBufferAction({
        ...armedSwitch,
        sessionMode: 'repeat',
        ownReadyTrackCount: 0,
        inFlightAheadCount: 2,
        hasCurrentRevisionGenerated: true,
      }),
    ).toEqual({ action: 'noop', generationStatus: 'ok' });
  });

  it('every money-safety guard still wins over an armed switch', () => {
    expect(decideBufferAction({ ...armedSwitch, costLimit: overDay }).action).toBe(
      'session_repeat',
    );
    expect(decideBufferAction({ ...armedSwitch, loopHeld: true }).action).toBe('noop');
    expect(decideBufferAction({ ...armedSwitch, hasConcurrencySlot: false }).action).toBe('wait');
    expect(decideBufferAction({ ...armedSwitch, listenerActive: false }).action).toBe('noop');
  });
});

describe('Style Snapshot revision initial fill', () => {
  it('generates the current revision while old-vibe Tracks remain ready ahead', () => {
    expect(
      decideBufferAction({
        ...base,
        readyAheadCount: 3,
        hasCurrentRevisionGenerated: false,
      }),
    ).toEqual({ action: 'generate', generationStatus: 'ok' });
  });
});

describe('Session mode drives generation (the Buffer default never blocks)', () => {
  /** A brand-new Repeat-mode session: nothing buffered, nothing ever generated. */
  const coldStart = {
    ...base,
    sessionMode: 'repeat' as const,
    ownReadyTrackCount: 0,
    hasEverGenerated: false,
    hasCurrentRevisionGenerated: false,
  };

  it('Repeat mode still runs the cold-start initial fill (one provider call)', () => {
    expect(decideBufferAction(coldStart)).toEqual({
      action: 'generate',
      generationStatus: 'ok',
    });
  });

  it('Repeat mode never tops up again once the session has generated — it loops', () => {
    // No new tracks are coming by choice: the player wraps at the end of the
    // queue (it loops on `sessionMode='repeat'`), so the controller just loops.
    expect(decideBufferAction({ ...base, sessionMode: 'repeat' })).toEqual({
      action: 'voluntary_repeat',
      generationStatus: 'ok',
    });
  });

  it('Repeat mode with every own track gone noops instead of looping nothing', () => {
    expect(decideBufferAction({ ...base, sessionMode: 'repeat', ownReadyTrackCount: 0 })).toEqual({
      action: 'noop',
      generationStatus: 'ok',
    });
  });

  it('an in-flight Repeat initial fill is not re-submitted and stays ok', () => {
    expect(decideBufferAction({ ...coldStart, inFlightAheadCount: 2 })).toEqual({
      action: 'noop',
      generationStatus: 'ok',
    });
  });

  it('skips the initial fill when the queue was seeded with ready tracks', () => {
    // A seeded session (e.g. Resume) may hold ready-ahead tracks before its first
    // generation request — those cover the buffer; no forced paid call.
    expect(decideBufferAction({ ...coldStart, readyAheadCount: 2 })).toEqual({
      action: 'noop',
      generationStatus: 'ok',
    });
  });

  it('the initial fill respects manual-only', () => {
    expect(decideBufferAction({ ...coldStart, manualGenerationOnly: true })).toEqual({
      action: 'noop',
      generationStatus: 'ok',
    });
  });

  it('at 1, tops up only once the buffer is empty', () => {
    expect(decideBufferAction({ ...base, bufferAheadTracks: 1, readyAheadCount: 1 })).toEqual({
      action: 'noop',
      generationStatus: 'ok',
    });
    expect(decideBufferAction({ ...base, bufferAheadTracks: 1, readyAheadCount: 0 })).toEqual({
      action: 'generate',
      generationStatus: 'ok',
    });
  });

  it('at 5, tops up while more than one slot is open and stops at the target', () => {
    // Each provider call yields ~2 tracks, so the top-up trigger is N-1: the
    // buffer hovers at ~N instead of overshooting it on every tick.
    expect(decideBufferAction({ ...base, bufferAheadTracks: 5, readyAheadCount: 3 })).toEqual({
      action: 'generate',
      generationStatus: 'ok',
    });
    expect(decideBufferAction({ ...base, bufferAheadTracks: 5, readyAheadCount: 4 })).toEqual({
      action: 'noop',
      generationStatus: 'ok',
    });
  });

  it('at 10, applies the same low watermark at the upper bound', () => {
    expect(decideBufferAction({ ...base, bufferAheadTracks: 10, readyAheadCount: 8 })).toEqual({
      action: 'generate',
      generationStatus: 'ok',
    });
    expect(decideBufferAction({ ...base, bufferAheadTracks: 10, readyAheadCount: 9 })).toEqual({
      action: 'noop',
      generationStatus: 'ok',
    });
  });

  it('clamps the ready-ahead target to the admin cap on queued tracks', () => {
    // The admin's cost control is the ceiling: a user with the maximum
    // ready-ahead setting must not out-buffer it.
    const capped = { ...base, bufferAheadTracks: 10, maxQueuedTracks: 2 };
    expect(decideBufferAction({ ...capped, readyAheadCount: 1 })).toEqual({
      action: 'noop',
      generationStatus: 'ok',
    });
    expect(decideBufferAction({ ...capped, readyAheadCount: 0 })).toEqual({
      action: 'generate',
      generationStatus: 'ok',
    });
    // At equality the cap changes nothing — the clamp is a ceiling, not a decrement.
    expect(
      decideBufferAction({ ...base, bufferAheadTracks: 5, maxQueuedTracks: 5, readyAheadCount: 3 }),
    ).toEqual({ action: 'generate', generationStatus: 'ok' });
    // Zero is a settable cap and means none: the watermark floor must not buy
    // the track back on an empty buffer.
    expect(decideBufferAction({ ...base, maxQueuedTracks: 0, readyAheadCount: 0 })).toEqual({
      action: 'noop',
      generationStatus: 'ok',
    });
  });

  it('admits a pending reroll in Keep Going mode', () => {
    expect(
      decideBufferAction({
        ...base,
        readyAheadCount: 3,
        rerollPending: true,
      }),
    ).toEqual({ action: 'generate', generationStatus: 'ok' });
  });

  it('never spends a pending reroll in Repeat mode — it loops instead', () => {
    // "Play existing Tracks" gates the Dislike reroll's fresh call too: the
    // disliked Track is gone, but nothing is bought to replace it.
    expect(
      decideBufferAction({
        ...base,
        sessionMode: 'repeat',
        readyAheadCount: 3,
        rerollPending: true,
        ownReadyTrackCount: 3,
      }),
    ).toEqual({ action: 'voluntary_repeat', generationStatus: 'ok' });
  });

  it('a Repeat-mode reroll with nothing left to loop still generates nothing', () => {
    expect(
      decideBufferAction({
        ...base,
        sessionMode: 'repeat',
        readyAheadCount: 0,
        rerollPending: true,
        ownReadyTrackCount: 0,
      }),
    ).toEqual({ action: 'noop', generationStatus: 'ok' });
  });

  it('a Repeat-mode revision initial fill still outranks the loop', () => {
    // Change Vibe is the one control whose whole purpose is new music, so its
    // revision fill stays mode-independent.
    expect(
      decideBufferAction({
        ...base,
        sessionMode: 'repeat',
        hasCurrentRevisionGenerated: false,
        readyAheadCount: 3,
        ownReadyTrackCount: 3,
      }),
    ).toEqual({ action: 'generate', generationStatus: 'ok' });
  });

  it('keeps every generation guard around admitted demand', () => {
    const admitted = {
      ...base,
      readyAheadCount: 3,
      rerollPending: true,
    };
    expect(decideBufferAction({ ...admitted, costLimit: overDay }).action).toBe('session_repeat');
    expect(decideBufferAction({ ...admitted, providerSignal: 'provider_error' }).action).toBe(
      'noop',
    );
    expect(decideBufferAction({ ...admitted, manualGenerationOnly: true }).action).toBe('noop');
    expect(decideBufferAction({ ...admitted, loopHeld: true }).action).toBe('noop');
    expect(decideBufferAction({ ...admitted, listenerActive: false }).action).toBe('noop');
    expect(decideBufferAction({ ...admitted, hasConcurrencySlot: false }).action).toBe('wait');
  });
});

describe('mapProviderBlockSignal', () => {
  const STALL = 5 * 60_000;
  /** A fresh (just-written) job in the given status, style unchanged. */
  const A_YEAR = 365 * 24 * 60 * 60_000;
  /** A job in the given status and age, under the conditions that lift a block. */
  const at = (
    normalizedStatus: Parameters<typeof mapProviderBlockSignal>[0]['normalizedStatus'],
    ageMs: number,
    lifts: {
      blockedStyleUnchanged?: boolean;
      refusalContextChanged?: boolean;
      listenerRestartedSince?: boolean;
    } = {},
  ) =>
    mapProviderBlockSignal({
      normalizedStatus,
      ageMs,
      stallThresholdMs: STALL,
      blockedStyleUnchanged: lifts.blockedStyleUnchanged ?? true,
      refusalContextChanged: lifts.refusalContextChanged ?? false,
      listenerRestartedSince: lifts.listenerRestartedSince ?? false,
    });

  it('maps fresh blocking provider-job conditions to generation block signals', () => {
    expect(at('blocked_by_provider_credits', 0)).toBe('provider_credits');
    expect(at('provider_rate_limited', 0)).toBe('provider_rate_limited');
    expect(at('failed_final', 0)).toBe('provider_error');
    expect(at('failed_retryable', 0)).toBe('provider_error');
  });

  it('decays each terminal block after its cooldown so generation can retry', () => {
    // Terminal statuses never change and a noop never creates a newer job, so a
    // non-expiring signal would block the session forever.
    expect(
      at('blocked_by_provider_credits', BLOCK_SIGNAL_COOLDOWNS_MS.provider_credits),
    ).toBeNull();
    expect(at('provider_rate_limited', BLOCK_SIGNAL_COOLDOWNS_MS.provider_rate_limited)).toBeNull();
    expect(at('failed_final', BLOCK_SIGNAL_COOLDOWNS_MS.provider_error)).toBeNull();
    expect(at('failed_retryable', BLOCK_SIGNAL_COOLDOWNS_MS.provider_error)).toBeNull();
    // Just inside the window it still blocks.
    expect(at('failed_final', BLOCK_SIGNAL_COOLDOWNS_MS.provider_error - 1)).toBe('provider_error');
  });

  it('a listener restart newer than a failed job lifts its cooldown', () => {
    // Try again and Resume are the listener's explicit request for another
    // batch; the cooldown only spaces unattended retries.
    for (const status of ['failed_final', 'failed_retryable'] as const) {
      expect(at(status, 2 * 60_000, { listenerRestartedSince: true })).toBeNull();
      expect(at(status, 2 * 60_000)).toBe('provider_error');
    }
  });

  it('a listener restart never lifts a policy block', () => {
    expect(at('blocked_by_policy', 0, { listenerRestartedSince: true })).toBe('provider_error');
  });

  it('blocks a policy-blocked prompt until the user changes the vibe, never on a clock', () => {
    // Same frozen prompt would be re-blocked — a paid retry storm — so time never
    // lifts this block, only a different compiled style (Change Vibe) does.
    expect(at('blocked_by_policy', 0)).toBe('provider_error');
    expect(at('blocked_by_policy', A_YEAR)).toBe('provider_error');
    expect(at('blocked_by_policy', 0, { blockedStyleUnchanged: false })).toBeNull();
    // A configuration change is not a policy answer: only the prompt lifts this.
    expect(at('blocked_by_policy', 0, { refusalContextChanged: true })).toBe('provider_error');
  });

  it('reports worker_stalled when live in-flight work is making no progress', () => {
    for (const status of ['submitted', 'processing', 'partially_ready'] as const) {
      expect(at(status, STALL + 1)).toBe('worker_stalled');
      expect(at(status, STALL)).toBeNull();
    }
  });

  it('stalls phantom submit states only while they hold their in-flight slot', () => {
    for (const status of ['queued', 'submit_unknown'] as const) {
      expect(at(status, 0)).toBeNull(); // a live submit in progress
      expect(at(status, STALL + 1)).toBe('worker_stalled'); // parked, still money-held
      expect(at(status, PHANTOM_SUBMIT_MAX_AGE_MS)).toBeNull(); // slot expired → generate
    }
  });

  it('reports a definitive submit refusal as a provider error, not a stall', () => {
    // A refused submit costs nothing, so it never trips the cost-limit degrade
    // that used to be the listener's signal that generation had stopped. Reading
    // it as `worker_stalled` would name the wrong culprit — nothing is in flight.
    expect(at('submit_rejected', 0)).toBe('provider_error');
  });

  it('never lifts a definitive refusal on the clock, only on a change', () => {
    // A refusal is free by construction, so the cost limits that bound every
    // other retry never engage: a decaying block would re-submit the same
    // refused request every cooldown for as long as anyone is listening.
    expect(at('submit_rejected', BLOCK_SIGNAL_COOLDOWNS_MS.provider_error)).toBe('provider_error');
    expect(at('submit_rejected', A_YEAR)).toBe('provider_error');
    // Change Vibe (a different compiled style) re-opens generation…
    expect(at('submit_rejected', A_YEAR, { blockedStyleUnchanged: false })).toBeNull();
    // …as does a credential/config update or an explicit restart.
    expect(at('submit_rejected', A_YEAR, { refusalContextChanged: true })).toBeNull();
  });

  it('returns null when the provider is not blocking', () => {
    expect(at('ready', 0)).toBeNull();
    expect(at('blocked_by_liedmotif_limit', 0)).toBeNull();
    expect(at('processing', 0)).toBeNull();
  });
});

describe('first fill outlives the listener window', () => {
  /** An Active Session that has never generated, past its Start's listener window. */
  const unheardFirstFill = {
    ...base,
    ownReadyTrackCount: 0,
    hasEverGenerated: false,
    hasCurrentRevisionGenerated: false,
    listenerActive: false,
  };

  it('buys the first batch without a listener, in either mode', () => {
    expect(decideBufferAction(unheardFirstFill)).toEqual({
      action: 'generate',
      generationStatus: 'ok',
    });
    expect(decideBufferAction({ ...unheardFirstFill, sessionMode: 'repeat' }).action).toBe(
      'generate',
    );
  });

  it('waits for a concurrency slot instead of giving up on the first batch', () => {
    expect(decideBufferAction({ ...unheardFirstFill, hasConcurrencySlot: false })).toEqual({
      action: 'wait',
      generationStatus: 'ok',
    });
  });

  it('a continuing fill stays listener-gated', () => {
    // Generated before: the top-up waits for someone to listen.
    expect(decideBufferAction({ ...unheardFirstFill, hasEverGenerated: true }).action).toBe('noop');
    // A later Change Vibe revision of a Session that has generated.
    expect(
      decideBufferAction({ ...unheardFirstFill, hasEverGenerated: true, readyAheadCount: 3 })
        .action,
    ).toBe('noop');
    // Never generated, but Resume seeded the Queue: its top-up is no first fill.
    expect(
      decideBufferAction({ ...unheardFirstFill, readyAheadCount: 1, ownReadyTrackCount: 1 }).action,
    ).toBe('noop');
    // The first batch is in flight: nothing more is bought for it.
    expect(decideBufferAction({ ...unheardFirstFill, inFlightAheadCount: 2 }).action).toBe('noop');
  });

  it('every other guard still binds the first fill', () => {
    expect(decideBufferAction({ ...unheardFirstFill, costLimit: overDay }).action).toBe(
      'session_repeat',
    );
    expect(
      decideBufferAction({ ...unheardFirstFill, providerSignal: 'provider_rate_limited' }).action,
    ).toBe('noop');
    expect(decideBufferAction({ ...unheardFirstFill, loopHeld: true }).action).toBe('noop');
  });
});

describe('playback-gated generation (no listener → no spend)', () => {
  it('noops below the watermark when nobody is listening', () => {
    expect(decideBufferAction({ ...base, listenerActive: false })).toEqual({
      action: 'noop',
      generationStatus: 'ok',
    });
  });

  it('still degrades to Session Repeat over the cost limit regardless of liveness', () => {
    expect(decideBufferAction({ ...base, listenerActive: false, costLimit: overDay })).toEqual({
      action: 'session_repeat',
      generationStatus: 'repeat_cost_limit',
      costLimitScope: 'instance',
      costLimitWindow: 'day',
    });
  });
});

describe('a Session with nothing to play stays visibly stuck', () => {
  /**
   * Generated before, its latest paid batch gave nothing: no playable Track,
   * nothing in flight, the failure cooldown over (no provider block signal),
   * and nobody listening.
   */
  const stuckUnheard = {
    ...base,
    ownReadyTrackCount: 0,
    readyAheadCount: 0,
    inFlightAheadCount: 0,
    providerSignal: null,
    listenerActive: false,
    stuck: true,
  };

  it('a Session with no playable Track and nothing in flight keeps its failure status after the cooldown', () => {
    expect(decideBufferAction(stuckUnheard)).toEqual({
      action: 'noop',
      generationStatus: 'provider_error',
    });
  });

  it('a Repeat Session with zero Tracks keeps its failure status and buys nothing', () => {
    for (const listenerActive of [false, true]) {
      expect(
        decideBufferAction({ ...stuckUnheard, sessionMode: 'repeat', listenerActive }),
      ).toEqual({ action: 'noop', generationStatus: 'provider_error' });
    }
  });

  it('buys nothing for a stuck Session without a listener, whatever else holds', () => {
    for (const overrides of [
      {},
      { sessionMode: 'repeat' as const },
      { rerollPending: true },
      { hasConcurrencySlot: false },
      { manualGenerationOnly: true },
      { loopHeld: true },
    ]) {
      const decision = decideBufferAction({ ...stuckUnheard, ...overrides });
      expect(decision.action).toBe('noop');
      expect(decision.generationStatus).toBe('provider_error');
    }
  });

  it('a provider block keeps its own status over the stuck one', () => {
    expect(decideBufferAction({ ...stuckUnheard, providerSignal: 'provider_credits' })).toEqual({
      action: 'noop',
      generationStatus: 'provider_credits',
    });
  });

  it('a Session with playable Tracks recovers by itself after a later failure', () => {
    // Its latest batch failed and the cooldown is over: not stuck, because it
    // has music. Without a listener it waits silently; with one it retries.
    const recovered = { ...base, ownReadyTrackCount: 4, stuck: false };
    expect(decideBufferAction({ ...recovered, listenerActive: false })).toEqual({
      action: 'noop',
      generationStatus: 'ok',
    });
    expect(decideBufferAction({ ...recovered, listenerActive: true })).toEqual({
      action: 'generate',
      generationStatus: 'ok',
    });
  });
});

describe('Try again on a stuck Session buys one batch', () => {
  /** Stuck, and the listener tapped Try again (or resumed) after the failure. */
  const retried = {
    ...base,
    ownReadyTrackCount: 0,
    readyAheadCount: 0,
    inFlightAheadCount: 0,
    providerSignal: null,
    listenerActive: true,
    stuck: true,
    retryRequested: true,
  };

  it('buys one batch in Keep Going and in Repeat', () => {
    for (const sessionMode of ['keep_going', 'repeat'] as const) {
      expect(decideBufferAction({ ...retried, sessionMode })).toEqual({
        action: 'generate',
        generationStatus: 'ok',
      });
    }
  });

  it('needs the listener the tap opened: a stale request buys nothing', () => {
    expect(decideBufferAction({ ...retried, listenerActive: false })).toEqual({
      action: 'noop',
      generationStatus: 'provider_error',
    });
  });

  it('passes every guard: a limit, a full concurrency, manual-only buy nothing', () => {
    expect(decideBufferAction({ ...retried, sessionMode: 'repeat', costLimit: overDay })).toEqual({
      action: 'session_repeat',
      generationStatus: 'repeat_cost_limit',
      costLimitScope: 'instance',
      costLimitWindow: 'day',
    });
    for (const overrides of [{ hasConcurrencySlot: false }, { manualGenerationOnly: true }]) {
      const decision = decideBufferAction({ ...retried, sessionMode: 'repeat', ...overrides });
      expect(decision.action).not.toBe('generate');
      expect(decision.generationStatus).toBe('provider_error');
    }
  });

  it('a policy block stays blocked under a retry', () => {
    expect(decideBufferAction({ ...retried, providerSignal: 'provider_error' })).toEqual({
      action: 'noop',
      generationStatus: 'provider_error',
    });
  });

  it('a Repeat Session that is not stuck gains no demand from a restart', () => {
    expect(
      decideBufferAction({
        ...retried,
        sessionMode: 'repeat',
        stuck: false,
        retryRequested: false,
      }),
    ).toEqual({ action: 'noop', generationStatus: 'ok' });
  });
});

describe('restartCountsAsListener', () => {
  it('counts a restart while nothing is in flight or something can play', () => {
    expect(restartCountsAsListener({ inFlightJobs: 0, hasPlayableTrack: false })).toBe(true);
    expect(restartCountsAsListener({ inFlightJobs: 1, hasPlayableTrack: true })).toBe(true);
  });

  it('with a batch in flight and nothing to play, waits for audio instead', () => {
    expect(restartCountsAsListener({ inFlightJobs: 1, hasPlayableTrack: false })).toBe(false);
  });
});

describe('isFailedPaidBatch', () => {
  it('a provider-reported failure is a failed paid batch', () => {
    for (const normalizedStatus of ['failed_final', 'failed_retryable'] as const) {
      expect(isFailedPaidBatch({ normalizedStatus, submitState: 'submitted' })).toBe(true);
    }
  });

  it('a poll that timed out is a failed paid batch', () => {
    // The poll attempt cap terminalizes the submitted job as `failed_final`.
    expect(isFailedPaidBatch({ normalizedStatus: 'failed_final', submitState: 'submitted' })).toBe(
      true,
    );
  });

  it('an uncertain submit may have been paid and counts as failed', () => {
    expect(
      isFailedPaidBatch({ normalizedStatus: 'submit_unknown', submitState: 'submit_unknown' }),
    ).toBe(true);
  });

  it('a successful batch or an unbilled refusal is not a failed paid batch', () => {
    expect(isFailedPaidBatch({ normalizedStatus: 'ready', submitState: 'submitted' })).toBe(false);
    for (const normalizedStatus of [
      'submit_rejected',
      'blocked_by_provider_credits',
      'provider_rate_limited',
    ] as const) {
      expect(isFailedPaidBatch({ normalizedStatus, submitState: 'submit_rejected' })).toBe(false);
    }
    expect(
      isFailedPaidBatch({
        normalizedStatus: 'blocked_by_liedmotif_limit',
        submitState: 'not_submitted',
      }),
    ).toBe(false);
  });
});

describe('repeat-one loop hold (held lease → no new paid jobs)', () => {
  it('noops below the watermark while a loop lease is held — even with a live listener', () => {
    // The looping player keeps pinging position reports, so listenerActive stays
    // true; the lease is what must stop the spend.
    expect(decideBufferAction({ ...base, loopHeld: true })).toEqual({
      action: 'noop',
      generationStatus: 'ok',
    });
  });

  it('never waits for a slot while held (no pending intent to generate)', () => {
    expect(decideBufferAction({ ...base, loopHeld: true, hasConcurrencySlot: false })).toEqual({
      action: 'noop',
      generationStatus: 'ok',
    });
  });

  it('keeps surfacing cost-limit Session Repeat and provider blocks while held', () => {
    // Neither branch spends; the truthful generationStatus wins over the hold.
    expect(decideBufferAction({ ...base, loopHeld: true, costLimit: overDay })).toEqual({
      action: 'session_repeat',
      generationStatus: 'repeat_cost_limit',
      costLimitScope: 'instance',
      costLimitWindow: 'day',
    });
    expect(
      decideBufferAction({ ...base, loopHeld: true, providerSignal: 'provider_credits' }),
    ).toEqual({ action: 'noop', generationStatus: 'provider_credits' });
  });
});

describe('isListenerActive', () => {
  const now = new Date('2026-06-29T12:00:00Z');
  const old = new Date(now.getTime() - LISTENER_ACTIVE_WINDOW_MS - 1);
  const recent = new Date(now.getTime() - LISTENER_ACTIVE_WINDOW_MS + 1000);

  it('is live right after Start (cold-start prefill) and after Resume', () => {
    expect(
      isListenerActive({ startedAt: recent, lastResumedAt: null, lastPlaybackReportAt: null }, now),
    ).toBe(true);
    expect(
      isListenerActive({ startedAt: old, lastResumedAt: recent, lastPlaybackReportAt: null }, now),
    ).toBe(true);
  });

  it('is live while playback reports keep arriving, and expires after the window', () => {
    expect(
      isListenerActive({ startedAt: old, lastResumedAt: null, lastPlaybackReportAt: recent }, now),
    ).toBe(true);
    expect(
      isListenerActive({ startedAt: old, lastResumedAt: old, lastPlaybackReportAt: old }, now),
    ).toBe(false);
  });

  it('counts only playing audio when restarts do not count', () => {
    const playbackOnly = { restartsCount: false };
    expect(
      isListenerActive(
        { startedAt: recent, lastResumedAt: recent, lastPlaybackReportAt: null },
        now,
        playbackOnly,
      ),
    ).toBe(false);
    expect(
      isListenerActive(
        { startedAt: old, lastResumedAt: old, lastPlaybackReportAt: recent },
        now,
        playbackOnly,
      ),
    ).toBe(true);
  });
});
