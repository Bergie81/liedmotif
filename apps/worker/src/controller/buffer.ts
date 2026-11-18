// Pure buffer / generation-controller decision. Given a
// snapshot of one active session's buffer + budget + provider state, decide what
// the worker should do this tick and which `generationStatus` to record. The
// session ALWAYS stays `active` — a cost limit degrades generation to Session
// Repeat (a controller status), it never moves the lifecycle.
//
// The session's own `sessionMode` is the sole authority over generation:
// `keep_going` keeps the buffer filled to the owner's ready-ahead target and
// honours a pending Dislike reroll, `repeat` loops the session's own tracks and
// buys nothing. Only a Style Snapshot revision's initial fill (cold start and
// Change Vibe) is mode-independent. The owner's `bufferEnabled` setting only
// picks the DEFAULT mode at session creation — it never reaches this decision,
// so switching a session to `keep_going` generates regardless of it.
//
// `generationStatus` legal values mapped here:
//   - repeat_cost_limit     — cost limit hit → loop the session's own tracks.
//   - provider_credits / provider_rate_limited / worker_stalled / provider_error
//                           — generation blocked by the provider; keep playing
//                             the ready tracks, no lifecycle change. A stuck
//                             Session (see `stuck`) keeps `provider_error`
//                             after the cooldown, for as long as it is stuck.
//   - ok                    — generating normally (or buffer already full /
//                             voluntary Repeat / manual-only). Returning to `ok`
//                             when the limit window rolls over IS the auto-resume.

import {
  isDurationTargetReached,
  LIVE_IN_FLIGHT_PROVIDER_STATUSES,
  PHANTOM_SUBMIT_MAX_AGE_MS,
  PHANTOM_SUBMIT_PROVIDER_STATUSES,
  phantomSubmitCutoffAt,
  type CostLimitDecision,
  type CostLimitScope,
  type CostLimitWindow,
  type ProviderNormalizedStatus,
  type SessionGenerationStatus,
  type SessionMode,
} from '@liedmotif/shared';

// The phantom-submit slot-hold bound and its cutoff derivation live in
// `@liedmotif/shared` next to `PHANTOM_SUBMIT_PROVIDER_STATUSES`, so non-worker
// `countInFlightSessionJobs` callers bound the hold identically; worker modules
// read them through the controller that owns the rule.
export { PHANTOM_SUBMIT_MAX_AGE_MS, phantomSubmitCutoffAt };

/** Why generation is blocked by the provider (never a cost limit — that is separate). */
export type GenerationBlockSignal = Extract<
  SessionGenerationStatus,
  'provider_credits' | 'provider_rate_limited' | 'worker_stalled' | 'provider_error'
>;

/** What the controller should do this tick. */
export type BufferAction =
  | 'generate' // submit a provider job for the admitted generation demand
  | 'session_repeat' // cost limit or duration target: loop the session's own tracks at zero cost
  | 'voluntary_repeat' // sessionMode='repeat' with own tracks: loop, stop generating
  | 'wait' // want to generate but no concurrency slot free this tick
  | 'noop'; // nothing to do (buffer full / manual-only / provider-blocked)

export interface BufferDecisionInput {
  sessionMode: SessionMode;
  /** Ready-ahead queue items (planned/generating/queued). */
  readyAheadCount: number;
  /**
   * Track-equivalent in-flight provider work for THIS session (submitting/submitted/
   * processing/partially_ready/submit_unknown jobs × tracks-per-call). Counted into
   * the buffer measure so overlapping sweeps and post-submit retries don't re-submit
   * a paid job before its tracks exist (money safety).
   */
  inFlightAheadCount: number;
  /**
   * Owner setting (Settings → Generation): how many tracks a `keep_going`
   * session keeps ready ahead of the playhead.
   */
  bufferAheadTracks: number;
  /**
   * The cost control bounding the above: the instance `usageLimits` value
   * for the Admin, the Member's own for a Member (the Pool states no
   * queue depth). A per-user ready-ahead setting is a preference INSIDE this
   * ceiling, never above it.
   */
  maxQueuedTracks: number;
  /**
   * Whether this Session has ever created a generation request the provider did
   * not refuse unbilled (dislikes and eviction never lower it). Distinguishes a
   * new Style Snapshot revision from a never-generated Session whose Queue was
   * seeded for Resume.
   */
  hasEverGenerated: boolean;
  /**
   * Whether the current Style Snapshot revision has created a generation request
   * the provider did not refuse unbilled — an unbilled refusal bought no batch,
   * so it never uses up the revision's initial fill.
   */
  hasCurrentRevisionGenerated: boolean;
  /**
   * A pending Dislike reroll intent (a fresh call owed for a rejected Track).
   * It is generation demand only in `keep_going`: "Play existing Tracks" gates
   * the reroll's fresh call like every other top-up.
   */
  rerollPending: boolean;
  /** The session's own already-generated ready tracks (Repeat viability + loop). */
  ownReadyTrackCount: number;
  manualGenerationOnly: boolean;
  /** In-flight provider jobs < maxConcurrentJobs. */
  hasConcurrencySlot: boolean;
  /**
   * Cost-window state across every bound that applies: the instance bound alone
   * for the Admin, the personal budget and the Pool for a Member. A
   * refusal carries the scope that bound it.
   */
  costLimit: CostLimitDecision;
  /** A provider block observed for this session, if any. */
  providerSignal?: GenerationBlockSignal | null;
  /**
   * Whether someone is actually listening (see `isListenerActive`): a playback
   * report — or the session's Start/Resume, for the cold-start prefill — within
   * the liveness window. PAID top-ups are gated on this, so an active-but-idle
   * session never spends while nobody is playing it. A never-generated
   * Session's first fill is exempt: it is the batch the Start asked for.
   */
  listenerActive: boolean;
  /**
   * Whether ANY client holds an unexpired, unreleased repeat-one loop lease on
   * this session (`hasLiveLoopLease`). A held
   * loop pins playback to one track, so prefill would only buy tracks nobody
   * is advancing toward: no NEW paid jobs while held. In-flight jobs finish
   * untouched, and a lapsed/released lease resumes prefill on the next tick.
   */
  loopHeld: boolean;
  /**
   * The Session has nothing to play and nothing coming: its latest request was
   * paid or may have been paid and did not succeed (`isFailedPaidBatch`), no
   * Track is playable, and nothing is in flight. Its failure must stay visible
   * for as long as that holds, not only for the provider-error cooldown.
   */
  stuck: boolean;
  /**
   * The Session duration target's progress, present only when the Session has
   * a target: usable generated seconds, Tracks whose duration is not yet
   * known, and whether a provider batch has results still to settle.
   */
  duration?: {
    targetMinutes: number;
    generatedSeconds: number;
    unknownTrackCount: number;
    batchOutstanding: boolean;
  };
}

export interface BufferDecision {
  action: BufferAction;
  generationStatus: SessionGenerationStatus;
  /** Copy that overrides the status's default message. */
  statusMessageSafe?: string;
  /**
   * Which bound refused, when the status is `repeat_cost_limit`: the instance
   * budget, the Member's personal one, or the shared Pool. The status payload
   * must never leave the reader inferring the scope from which number looks
   * smaller.
   */
  costLimitScope?: CostLimitScope;
  /**
   * Which window of that bound: a rolling `day`/`month` that rolls over, or a
   * One-time `total` that never does — the copy must not promise a reset then.
   */
  costLimitWindow?: CostLimitWindow;
}

export function decideBufferAction(input: BufferDecisionInput): BufferDecision {
  const decision = decideSupplyAction(input);
  // A stuck Session that buys nothing this tick keeps reporting its failure:
  // an `ok` would drop the banner and leave the player narrating a connection
  // that is not coming. Nothing here buys a retry; that still needs a listener.
  if (input.stuck && decision.action !== 'generate' && decision.generationStatus === 'ok') {
    return { ...decision, generationStatus: 'provider_error' };
  }
  return decision;
}

function decideSupplyAction(input: BufferDecisionInput): BufferDecision {
  // 0. Session duration target → outranks every other demand, the revision
  //    initial fill included. Reaching it repeats the Session; below it, a Track
  //    of unknown duration or an unsettled batch holds the next purchase, so the
  //    target overshoots by at most one whole batch.
  const { duration } = input;
  if (duration) {
    if (isDurationTargetReached(duration.targetMinutes, duration.generatedSeconds)) {
      return { action: 'session_repeat', generationStatus: 'ok' };
    }
    if (duration.unknownTrackCount > 0) {
      return {
        action: 'wait',
        generationStatus: 'ok',
        statusMessageSafe: 'Waiting for audio duration measurement before generating more music.',
      };
    }
    if (duration.batchOutstanding) {
      return { action: 'wait', generationStatus: input.providerSignal ?? 'ok' };
    }
  }

  // 1. Cost limit → Session Repeat. Loop the session's own exact-vibe tracks at
  //    zero cost; the session stays active and auto-resumes when the window rolls
  //    over (this branch simply stops being taken once `costLimit.withinLimits`).
  if (!input.costLimit.withinLimits) {
    return {
      action: 'session_repeat',
      generationStatus: 'repeat_cost_limit',
      costLimitScope: input.costLimit.scope,
      costLimitWindow: input.costLimit.window,
    };
  }

  // 2. Within budget but the provider is blocking generation → surface it and
  //    keep playing the ready tracks (no Session Repeat, no lifecycle change).
  if (input.providerSignal) {
    return { action: 'noop', generationStatus: input.providerSignal };
  }

  const bufferedAhead = input.readyAheadCount + input.inFlightAheadCount;
  // Every Style Snapshot revision gets one initial fill. A Session's first
  // revision waits only when Resume has already seeded its Queue; later revisions
  // fill immediately while old-vibe Tracks remain available to play out.
  const needsRevisionInitialFill =
    !input.hasCurrentRevisionGenerated && (input.hasEverGenerated || bufferedAhead === 0);
  // Automatic top-up watermark: a provider batch yields ~2 Tracks, so topping up
  // when one slot is open (N-1, floored at 1) keeps the buffer hovering at ~N
  // without overshooting on every tick. Counting in-flight work is what stops a
  // duplicate paid job while the first is still generating. N is the ready-ahead
  // setting under the queued-track ceiling — a preference and a cost control, so
  // the tighter one wins. A ZERO ceiling means no ready-ahead at all, so the
  // floor — which exists for the setting, whose range starts at 1 — must not
  // restore a track the ceiling refused.
  const readyAheadTarget = Math.min(input.bufferAheadTracks, input.maxQueuedTracks);
  const belowWatermark = readyAheadTarget > 0 && bufferedAhead < Math.max(readyAheadTarget - 1, 1);
  // `sessionMode` gates BOTH the automatic top-up and the Dislike reroll's fresh
  // call; the sweep cancels a `repeat` session's reroll
  // intents upstream, but this function is the decision authority and states the
  // whole rule itself. The one demand the mode does NOT gate is the revision
  // initial fill: Change Vibe exists to produce new music, so a revision that
  // generated nothing in Repeat mode would be a dead control.
  const hasGenerationDemand =
    needsRevisionInitialFill ||
    (input.sessionMode === 'keep_going' && (belowWatermark || input.rerollPending));

  // 3. Voluntary Repeat (user intent): loop whatever the session already has —
  //    Repeat mode fills no target. Only the revision initial fill outranks the
  //    loop; with no own track left there is nothing to loop, so fall through.
  if (!needsRevisionInitialFill && input.sessionMode === 'repeat' && input.ownReadyTrackCount > 0) {
    return { action: 'voluntary_repeat', generationStatus: 'ok' };
  }

  // 4. Manual-only policy: this controller submits no provider job.
  if (input.manualGenerationOnly) {
    return { action: 'noop', generationStatus: 'ok' };
  }

  // 5. Repeat-one hold: an unexpired loop lease pins playback to one
  //    track — no new paid jobs while it lives (the seam adds no spend; prefill
  //    stops within one sweep tick of an acknowledged hold). Not a block and not
  //    a lifecycle change: generationStatus stays `ok`, in-flight jobs finish,
  //    and expiry/release simply stops this branch being taken.
  if (input.loopHeld) {
    return { action: 'noop', generationStatus: 'ok' };
  }

  // 6. No generation demand this tick → nothing to do.
  if (!hasGenerationDemand) {
    return { action: 'noop', generationStatus: 'ok' };
  }

  // 7. Admitted generation demand still requires a listener. The next playback
  //    report (or Start/Resume) makes the listener active again and a following
  //    tick can submit — generation is playback-gated, never playback-blind.
  //    The one exception is a never-generated Session's first fill: the Start
  //    already asked for that batch, and it can be held up past the listener
  //    window (a concurrency slot still taken, a provider block's cooldown)
  //    with nothing playing to report a listener. It is bounded to that one
  //    batch, and idle auto-stop still ends an abandoned Session.
  const isFirstFill = needsRevisionInitialFill && !input.hasEverGenerated;
  if (!input.listenerActive && !isFirstFill) {
    return { action: 'noop', generationStatus: 'ok' };
  }

  // 8. Live listener (or first fill) and admitted demand → submit if a
  //    concurrency slot is free.
  if (!input.hasConcurrencySlot) {
    return { action: 'wait', generationStatus: 'ok' };
  }
  return { action: 'generate', generationStatus: 'ok' };
}

/**
 * Whether a Session's latest provider job is a batch that was paid or may have
 * been paid and gave nothing: a provider-reported failure, a poll that timed
 * out (terminalized as `failed_final`), or an uncertain submit. An unbilled
 * refusal or a job that never reached the provider bought nothing, so it is no
 * failed paid batch. Whether the job still holds an in-flight slot is the
 * caller's separate question.
 */
export function isFailedPaidBatch(job: {
  normalizedStatus: ProviderNormalizedStatus;
  submitState: string;
}): boolean {
  if (job.submitState === 'submit_rejected' || job.submitState === 'not_submitted') return false;
  return job.normalizedStatus !== 'ready';
}

/**
 * How recent a playback report (or Start/Resume) must be for the session to
 * count as "someone is listening". The player pings a position report every
 * ~5s while audio plays and the sweep ticks every 60s, so 2 minutes tolerates
 * missed pings and sweep jitter while cutting spend off within ~2 minutes of
 * a pause/close. Start/Resume open the same window so the cold-start prefill
 * (tracks must exist before play can begin) still happens.
 */
export const LISTENER_ACTIVE_WINDOW_MS = 2 * 60_000;

/**
 * Whether the session has a live listener: the most recent of Start, Resume,
 * and last playback report falls within the liveness window. Pure; the buffer
 * tick feeds it the locked session row.
 */
export function isListenerActive(
  session: { startedAt: Date; lastResumedAt: Date | null; lastPlaybackReportAt: Date | null },
  now: Date,
): boolean {
  const latest = Math.max(
    session.startedAt.getTime(),
    session.lastResumedAt?.getTime() ?? 0,
    session.lastPlaybackReportAt?.getTime() ?? 0,
  );
  return now.getTime() - latest < LISTENER_ACTIVE_WINDOW_MS;
}

/**
 * How long each blocking provider-job condition keeps generation blocked,
 * measured from the job's `updatedAt`. Terminal provider statuses never change
 * again and a `noop` never creates the newer job that would replace them as the
 * session's latest — so a signal that never expired would block generation
 * FOREVER (one failed job would end the "continuous listening session"). Each
 * block therefore decays after a cooldown, letting the controller submit a fresh
 * job. Retries stay bounded: they are spaced by the cooldown and every billable
 * one is counted against the cost limits, so a persistently failing provider
 * degrades to `repeat_cost_limit` instead of a tight paid retry storm. An
 * unbilled refusal that clears on its own (out of credits, maintenance, a rate
 * limit) lands on these same statuses and costs nothing to retry, so its
 * cooldown alone spaces it.
 */
export const BLOCK_SIGNAL_COOLDOWNS_MS = {
  /** Credits stay empty until the admin tops up; re-check on a slow cadence. */
  provider_credits: 15 * 60_000,
  /** Provider rate limits clear in seconds-to-minutes (Suno: 20 req / 10 s). */
  provider_rate_limited: 60_000,
  /** Terminal failure/timeout: give the provider a breather, then try again. */
  provider_error: 10 * 60_000,
} as const satisfies Partial<Record<GenerationBlockSignal, number>>;

/**
 * Map the latest provider-job condition for a session to a generation block
 * signal (or null when the provider is not blocking). Pure time-window logic:
 * `ageMs` is now − the job's `updatedAt`, and each blocking condition expires
 * per the cooldowns above so no block outlives its usefulness.
 */
export function mapProviderBlockSignal(input: {
  normalizedStatus: ProviderNormalizedStatus;
  /** Milliseconds since the job's last write (now − updatedAt). */
  ageMs: number;
  /** An in-flight job silent for longer than this reads as `worker_stalled`. */
  stallThresholdMs: number;
  /**
   * The two clock-free blocks (`blocked_by_policy`, `submit_rejected`) only: the
   * style THIS tick would submit still equals the style the provider refused
   * (also pass true when either side is unknown — fail closed against a retry
   * storm). Neither block decays on a clock, because resubmitting the same
   * frozen prompt would just be refused again ("needs a new, user-edited
   * request"); a Change Vibe producing a different compiled style lifts both.
   */
  blockedStyleUnchanged: boolean;
  /**
   * `submit_rejected` only: something that could change the refusal's outcome
   * has happened since it was recorded — the provider configuration changed, or
   * the listener explicitly restarted the session.
   */
  refusalContextChanged: boolean;
}): GenerationBlockSignal | null {
  const status = input.normalizedStatus;
  switch (status) {
    case 'blocked_by_provider_credits':
      return input.ageMs < BLOCK_SIGNAL_COOLDOWNS_MS.provider_credits ? 'provider_credits' : null;
    case 'provider_rate_limited':
      return input.ageMs < BLOCK_SIGNAL_COOLDOWNS_MS.provider_rate_limited
        ? 'provider_rate_limited'
        : null;
    case 'failed_retryable':
    case 'failed_final':
      return input.ageMs < BLOCK_SIGNAL_COOLDOWNS_MS.provider_error ? 'provider_error' : null;
    // A definitive refusal reads as a provider error rather than the phantom
    // stall bucket below — nothing is in flight to be waiting on — and it never
    // decays on a clock. The cooldown above is bounded by the cost limits every
    // retry is counted against; a refusal is unbilled by construction, so that
    // backstop never engages and a decaying block would re-submit the same
    // refused request every cooldown, forever. It is terminal for this compiled
    // style + provider-config revision, and lifts exactly like a policy block:
    // when the user or the configuration changes something.
    case 'submit_rejected':
      return input.blockedStyleUnchanged && !input.refusalContextChanged ? 'provider_error' : null;
    case 'blocked_by_policy':
      return input.blockedStyleUnchanged ? 'provider_error' : null;
  }
  // Phantom submit states (shared bucket: nothing advances them): surface the stall
  // while the job still holds its in-flight slot and clear it when the slot expires
  // (strictly `< PHANTOM_SUBMIT_MAX_AGE_MS`, the exact mirror of the
  // `countInFlightSessionJobs` cutoff) — otherwise the signal itself would keep the
  // session noop-ing forever behind a dead submit.
  if ((PHANTOM_SUBMIT_PROVIDER_STATUSES as readonly ProviderNormalizedStatus[]).includes(status)) {
    return input.ageMs > input.stallThresholdMs && input.ageMs < PHANTOM_SUBMIT_MAX_AGE_MS
      ? 'worker_stalled'
      : null;
  }
  // Live in-flight work (shared bucket): the poll loop advances or terminalizes it
  // (the attempt cap ends as `failed_final`, which then decays above), so a long
  // silence is surfaced as a stall without an expiry of its own.
  if ((LIVE_IN_FLIGHT_PROVIDER_STATUSES as readonly ProviderNormalizedStatus[]).includes(status)) {
    return input.ageMs > input.stallThresholdMs ? 'worker_stalled' : null;
  }
  // `ready` / pre-submit `blocked_by_liedmotif_limit` — not blocking.
  return null;
}
