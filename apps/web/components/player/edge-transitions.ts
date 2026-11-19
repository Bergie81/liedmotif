// The prepared-deck transition driver.
//
// Owns the WHOLE lifecycle of one in-flight preparation: begin (load the
// inactive deck via its pinned ladder), readiness deadline, edge decision +
// context-clock scheduling (`edge-plan.ts`), the incoming element's muted
// pre-roll with its start-miss guard, the logical commit AT the fade boundary,
// and cancellation from every state. State moves exclusively through the
// unit-tested `preparedDeckTransition` table; this driver executes the
// returned actions against the DOM/engine through its host.
//
// The host interface is the seam to the controller hook: element access, the
// deck-load ladder (shared with ACTIVE deck loads, so it stays in the hook),
// the next-target resolution, and the commit side effects (reports, cursor,
// metadata, UI state).

import {
  crossfadeStartSeconds,
  decideEdge,
  preparedDeckTransition,
  soloLoudnessGainDb,
  UNPRESERVED_PITCH_RATE_CAP,
  upperEnvelopePositionSeconds,
  type CommittedSourceKind,
  type EdgeEndpoint,
  type PlaybackSettings,
  type PreparedDeckAction,
  type PreparedDeckEvent,
  type PreparedDeckState,
} from '@liedmotif/shared';
import type { DeckId, PlayerEngine } from './audio-engine';
import type { BufferDecks } from './buffer-decks';
import {
  degradeEdgeDecision,
  degradePlannedEdge,
  planEdge,
  type PlannedEdge,
  soloEdgeGains,
} from './edge-plan';
import { emitBlendEdge, loudnessOf, type PlayableTrack, type QueueTarget } from './playable-track';

// Begin preloading the inactive deck this many seconds before the fade start.
const PREPARE_LEAD_SECONDS = 8;
// Readiness must beat the fade start by this margin, or the preparation fails
// (the edge then degrades to the sequential natural-end advance).
const SCHEDULE_MARGIN_SECONDS = 0.75;
// A beat-aligned start must be at least this far ahead when scheduled.
const MIN_ALIGN_LEAD_SECONDS = 0.35;
/**
 * How late the incoming element's ACTUAL start may run before the alignment is
 * declared dead and the armed automation is cancelled (fail → sequential end).
 * 120 ms is far beyond the 40 ms p95 media budget yet under half a beat across
 * the whole persistable BPM range (40–220 → shortest half-beat ≈ 136 ms).
 */
const ALIGNED_START_MISS_SECONDS = 0.12;
/**
 * Below this measured start error the muted pre-roll is left alone (seek
 * granularity noise); above it the error is SEEKED AWAY before the fade
 * becomes audible. An element's `play()` carries real pipeline start latency
 * that two element decks share (it cancels) but an exact buffer reference
 * exposes — the mixed buffer→element edge would otherwise burn its whole
 * media budget on it.
 */
const PREROLL_CORRECTION_FLOOR_SECONDS = 0.01;

/** What the driver needs from the controller hook. */
export interface EdgeTransitionHost {
  deckEl(deck: DeckId): HTMLAudioElement | null;
  engine(): PlayerEngine | null;
  settings(): PlaybackSettings;
  activeDeck(): DeckId;
  deckTrack(deck: DeckId): PlayableTrack | null;
  committedKind(deck: DeckId): CommittedSourceKind | null;
  /** Start the deck's pinned source ladder; false when nothing is loadable. */
  loadDeck(deck: DeckId, track: PlayableTrack): boolean;
  /** Stop + unload the deck element and clear its ladder state. */
  unloadDeck(deck: DeckId): void;
  /** The transition target (next queue index, incl. the Session Repeat wrap). */
  nextTarget(): QueueTarget | null;
  /** Whether a Track may still start now: an offline copy can expire after
   *  its deck was prepared, and then never starts. */
  startable(track: PlayableTrack): boolean;
  /** The logical handoff: deck switch, cursor, `started` report, metadata, UI.
   *  `queueWrapped` relays the target's Queue-loop-restart provenance into the
   *  report. */
  commit(deck: DeckId, track: PlayableTrack, idx: number, queueWrapped: boolean): void;
  /** The buffer transport, or null where it does not exist. */
  buffers(): BufferDecks | null;
  /** Session-level buffer-transport qualification: internal flag, decode API,
   *  `navigator.deviceMemory` (runtime safety gates). */
  bufferEligible(): boolean;
}

/** An in-flight preparation. `state` moves ONLY through the transition table. */
interface Preparation {
  state: PreparedDeckState;
  deck: DeckId;
  track: PlayableTrack;
  idx: number;
  /** The target's Queue-loop-restart provenance, handed to `commit`. */
  queueWrapped: boolean;
  /** Fails the preparation if readiness never arrives in time. */
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  /** Starts the incoming element's muted pre-roll (aligned edges). */
  startTimer: ReturnType<typeof setTimeout> | null;
  /** Commits the logical handoff at the FADE boundary, after the pre-roll. */
  commitTimer: ReturnType<typeof setTimeout> | null;
  /** Fails the edge if the incoming start never happens inside the miss window. */
  guardTimer: ReturnType<typeof setTimeout> | null;
  /** Bounds the buffer decode-wait; expiry falls back to the media plan. */
  bufferWaitTimer: ReturnType<typeof setTimeout> | null;
  /** Samples the outgoing ELEMENT clock during the decode-wait: a single raw
   *  `currentTime` read understates the position by up to one quantization
   *  step, which would land every mixed-edge buffer start late by that bias. */
  clockSampler: ReturnType<typeof setInterval> | null;
  clockSamples: Array<{ mediaTime: number; contextTime: number }>;
  planned: PlannedEdge | null;
  /** Element-start error vs the plan, measured when the pre-roll begins. */
  measuredPhaseErrorMs: number | null;
  /** Where the incoming element's media time 0 landed on the context clock. */
  actualStartContextTime: number | null;
}

export class EdgeTransitions {
  private prep: Preparation | null = null;

  constructor(private readonly host: EdgeTransitionHost) {}

  /** Whether a preparation currently occupies `deck` (any state incl. failed). */
  prepDeck(): DeckId | null {
    return this.prep?.deck ?? null;
  }

  /** Whether an edge for this queue item is SCHEDULED (its automation armed).
   * The loop toggle-off consults it: an armed seam completes before the pin
   * ends, while anything earlier cancels. */
  scheduledFor(queueItemId: string): boolean {
    return this.prep?.state === 'scheduled' && this.prep.track.queueItemId === queueItemId;
  }

  /** Active-deck tick (element `timeupdate`, or the controller's buffer-clock
   * cadence when the muted carrier is dead): begin preparation ahead of the
   * fade start, and fire a ready plain edge at the classic crossfade
   * threshold. The POSITION comes from the deck's own frame — the buffer
   * transport's exact clock when the deck plays a decoded buffer — so a
   * parked/stale carrier element can never stall the next transition. */
  onTimeUpdate(el: HTMLAudioElement, fadeStartSeconds: number): void {
    const position = this.outClock(this.host.activeDeck(), el).positionSeconds;
    let prep = this.prep;
    if (prep && !this.host.startable(prep.track)) {
      this.cancel();
      prep = null;
    }
    if (!prep) {
      if (position >= fadeStartSeconds - PREPARE_LEAD_SECONDS) {
        this.beginPreparation(el, fadeStartSeconds);
      }
      return;
    }
    if (prep.state === 'ready' && position >= fadeStartSeconds) {
      this.applyEvent(prep, { type: 'schedule' });
      this.startIncoming(prep);
    }
  }

  /** The prepared deck reached readiness (its source commit just landed). */
  onDeckReady(deck: DeckId): void {
    const prep = this.prep;
    if (prep?.deck !== deck || prep.state !== 'loading') return;
    if (prep.deadlineTimer != null) {
      clearTimeout(prep.deadlineTimer);
      prep.deadlineTimer = null;
    }
    this.applyEvent(prep, { type: 'loaded' });
    this.scheduleEdge(prep);
  }

  /** The prepared deck's source died (ladder exhausted / post-readiness error).
   * True when the error belonged to this driver's preparation. */
  onDeckFailed(deck: DeckId): boolean {
    const prep = this.prep;
    if (prep?.deck !== deck) return false;
    if (prep.state === 'loading') {
      // Keep the FAILED preparation in place so timeupdate does not re-walk a
      // 404ing ladder in a loop; navigation/queue-replacement/`ended` clears it.
      this.fail(prep, { type: 'load-error' });
    } else {
      // A source dying AFTER readiness is still a FAILED ATTEMPT — it must be
      // counted (no survivorship bias) — but a fresh preparation may retry
      // (the asset exists; the source died mid-flight), so the prep slot is
      // RELEASED (cancel semantics) rather than parked as `failed`.
      const wasScheduled = prep.state === 'scheduled';
      this.prep = null;
      this.clearTimers(prep);
      this.runAction(prep, this.applyEvent(prep, { type: 'cancel' }));
      this.emitFailedAttempt(prep, wasScheduled);
    }
    return true;
  }

  /** Queue replacement: the prepared track must still be the transition target. */
  syncTarget(target: QueueTarget | null): void {
    const prep = this.prep;
    if (!prep) return;
    if (!target || target.track.queueItemId !== prep.track.queueItemId) {
      this.cancel();
    } else {
      prep.idx = target.idx;
      prep.queueWrapped = target.wrapped ?? false;
    }
  }

  /** Cancel from WHATEVER state (pause/skip/back/dislike/stop/replacement). */
  cancel(): void {
    const prep = this.prep;
    if (!prep) return;
    this.prep = null;
    this.clearTimers(prep);
    this.runAction(prep, this.applyEvent(prep, { type: 'cancel' }));
  }

  // --- internals -----------------------------------------------------------

  private applyEvent(prep: Preparation, event: PreparedDeckEvent): PreparedDeckAction {
    const next = preparedDeckTransition(prep.state, event);
    prep.state = next.state;
    return next.action;
  }

  private clearTimers(prep: Preparation): void {
    for (const key of [
      'deadlineTimer',
      'startTimer',
      'commitTimer',
      'guardTimer',
      'bufferWaitTimer',
    ] as const) {
      const timer = prep[key];
      if (timer != null) clearTimeout(timer);
      prep[key] = null;
    }
    if (prep.clockSampler != null) {
      clearInterval(prep.clockSampler);
      prep.clockSampler = null;
    }
  }

  /** Execute a transition-table action: unload the prepared deck, and for a
   * cancelled SCHEDULED edge settle the graph back onto the active deck —
   * park every armed automation and restore the active track's solo gain. */
  private runAction(prep: Preparation, action: PreparedDeckAction): void {
    if (action === 'none') return;
    this.host.unloadDeck(prep.deck);
    if (action === 'cancel-schedule') {
      const active = this.host.activeDeck();
      this.host
        .engine()
        ?.hardCut(active, soloLoudnessGainDb(loudnessOf(this.host.deckTrack(active))));
    }
  }

  /** Fail the preparation via `event` but KEEP it (state `failed`), so the
   * timeupdate trigger does not endlessly retry; playback runs the current
   * track out and `ended` advances sequentially. EVERY failed attempt emits
   * runtime-degrade telemetry — a scheduled edge that died (`start-missed`)
   * and a preparation that never reached readiness (`prepare-failed`) alike —
   * so the acceptance measurement counts attempts, not just the edges that
   * survived (no survivorship bias). Deliberate cancellation (user actions,
   * queue replacement) is NOT a failed attempt and emits nothing. */
  private fail(prep: Preparation, event: PreparedDeckEvent): void {
    const missedScheduledEdge = prep.state === 'scheduled';
    this.clearTimers(prep);
    this.runAction(prep, this.applyEvent(prep, event));
    this.emitFailedAttempt(prep, missedScheduledEdge);
  }

  /** One degraded telemetry event per failed attempt: a SCHEDULED edge that
   * died is a `start-missed`, anything earlier a `prepare-failed`. */
  private emitFailedAttempt(prep: Preparation, missedScheduledEdge: boolean): void {
    const degraded = degradeEdgeDecision(
      prep.planned?.decision ?? { tier: 'plain', reasons: [], loudnessNormalized: false },
      missedScheduledEdge ? 'start-missed' : 'prepare-failed',
    );
    emitBlendEdge({
      ...this.edgeDetail(prep),
      committed: false,
      tier: degraded.tier,
      reasons: degraded.reasons,
      incomingRate: prep.planned?.aligned?.incomingRate ?? null,
    });
  }

  /** The measurement fields every blend-edge event carries — one builder, so a
   * new field can never reach one outcome (commit/failure) and miss the other. */
  private edgeDetail(prep: Preparation) {
    return {
      tier: prep.planned?.decision.tier ?? ('plain' as const),
      reasons: prep.planned?.decision.reasons ?? [],
      trackId: prep.track.trackId,
      phaseErrorMs: prep.measuredPhaseErrorMs,
      actualStartContextTime: prep.actualStartContextTime,
      fadeStartContextTime: prep.planned?.aligned?.fadeStartContextTime ?? null,
      presentationFadeStartContextTime:
        prep.planned?.aligned?.presentationFadeStartContextTime ?? null,
      incomingRate: prep.planned?.aligned?.incomingRate ?? 1,
      fadeSeconds: prep.planned?.aligned?.fadeSeconds ?? this.host.settings().crossfadeSeconds,
    };
  }

  private beginPreparation(outEl: HTMLAudioElement, fadeStartSeconds: number): void {
    const target = this.host.nextTarget();
    if (!target) return;
    const deck: DeckId = this.host.activeDeck() === 'a' ? 'b' : 'a';
    // The inactive deck may still be fading out the PREVIOUS track's tail
    // (short tracks / long fades): loading it now would kill that tail
    // mid-fade. Wait — its `ended` clears the slot and timeupdate retries.
    if (this.host.deckTrack(deck) != null) return;

    const prep: Preparation = {
      state: 'idle',
      deck,
      track: target.track,
      idx: target.idx,
      queueWrapped: target.wrapped ?? false,
      deadlineTimer: null,
      startTimer: null,
      commitTimer: null,
      guardTimer: null,
      bufferWaitTimer: null,
      clockSampler: null,
      clockSamples: [],
      planned: null,
      measuredPhaseErrorMs: null,
      actualStartContextTime: null,
    };
    if (!this.host.loadDeck(deck, target.track)) return;
    this.applyEvent(prep, { type: 'prepare' });
    this.prep = prep;

    // Readiness deadline: the fade start minus a scheduling margin, on the
    // wall clock (media seconds / rate) — from the outgoing deck's OWN frame
    // (a buffer deck's exact clock, not a possibly-stale carrier element).
    const clock = this.outClock(this.host.activeDeck(), outEl);
    const rate = clock.playbackRate > 0 ? clock.playbackRate : 1;
    const remainingSeconds =
      (fadeStartSeconds - clock.positionSeconds) / rate - SCHEDULE_MARGIN_SECONDS;
    prep.deadlineTimer = setTimeout(
      () => {
        if (this.prep === prep && prep.state === 'loading') {
          this.fail(prep, { type: 'deadline' });
        }
      },
      Math.max(0, remainingSeconds * 1000),
    );
  }

  /** Decide + arm the edge at readiness. Buffer-qualifying edges first wait
   * (bounded) for the incoming final to DECODE, then arm the beat-locked
   * schedule; everything else arms the media plan directly. Aligned edges
   * schedule the fade on the context clock and the pre-roll ahead of it; plain
   * edges (incl. the runtime degrades) stay `ready` and fire from the
   * timeupdate threshold. */
  private scheduleEdge(prep: Preparation): void {
    if (this.bufferCandidate(prep)) {
      this.beginBufferDecodeWait(prep);
      return;
    }
    this.armPlannedEdge(prep, this.planFor(prep, 'media'));
  }

  /** Whether this edge may run on buffer transport: session gate
   * (flag, decode API, deviceMemory), trusted clock mapping, pinned FINALS
   * committed on both sides, and a policy decision of `beat-locked` (the
   * drift guard caps at `beat-aligned` ⇒ media decks). The outgoing deck
   * either already plays its decoded buffer or stays an element for this one
   * MIXED bootstrap edge. */
  private bufferCandidate(prep: Preparation): boolean {
    const engine = this.host.engine();
    const outDeck = this.host.activeDeck();
    const outTrack = this.host.deckTrack(outDeck);
    const committed = this.host.committedKind(prep.deck);
    if (!engine || !engine.isActive || !outTrack || !committed) return false;
    if (!this.host.buffers() || !this.host.bufferEligible()) return false;
    if (!engine.alignedSchedulingSupported()) return false;
    const outCommitted = this.host.committedKind(outDeck);
    if (committed !== 'final' || outCommitted !== 'final') return false;
    const decision = decideEdge(
      this.endpointOf(outTrack, outCommitted),
      this.endpointOf(prep.track, committed),
      { transport: 'buffer' },
    );
    return decision.tier === 'beat-locked';
  }

  /** Bounded decode-wait ("both finals decoded" before a beat-locked arm): on
   * decode success the buffer plan arms; on failure or deadline the edge
   * falls back to the ELEMENT deck plan, uninterrupted. The wait leaves the media
   * fallback its scheduling margin. */
  private beginBufferDecodeWait(prep: Preparation): void {
    const buffers = this.host.buffers();
    const outEl = this.host.deckEl(this.host.activeDeck());
    const clock = outEl ? this.outClock(this.host.activeDeck(), outEl) : null;
    if (!buffers || !clock) {
      this.armPlannedEdge(prep, this.planFor(prep, 'media'));
      return;
    }
    const fadeStartSeconds = crossfadeStartSeconds(
      clock.durationSeconds,
      this.host.settings().crossfadeSeconds,
    );
    const rate = clock.playbackRate > 0 ? clock.playbackRate : 1;
    const budgetMs =
      ((fadeStartSeconds - clock.positionSeconds) / rate - SCHEDULE_MARGIN_SECONDS) * 1000;
    if (budgetMs <= 0) {
      this.armPlannedEdge(prep, this.planFor(prep, 'media'));
      return;
    }
    // MIXED edges only: sample the outgoing ELEMENT clock while the decode
    // runs. A single raw `currentTime` read understates the position by up to
    // one quantization step — the upper envelope of many samples removes that
    // bias from the sample-accurate buffer placement. (A buffer-outgoing
    // deck's clock is exact; nothing to refine.)
    if (clock.frame === 'element') {
      const engine = this.host.engine();
      const takeSample = () => {
        const nowCtx = engine?.now();
        const el = this.host.deckEl(this.host.activeDeck());
        if (nowCtx == null || !el || el.paused) return;
        prep.clockSamples.push({ mediaTime: el.currentTime, contextTime: nowCtx });
        if (prep.clockSamples.length > 16) prep.clockSamples.shift();
      };
      // One sample IMMEDIATELY: a cached decode can settle before the first
      // interval tick, and the refinement must never silently fall back to a
      // single raw read it was built to replace.
      takeSample();
      prep.clockSampler = setInterval(takeSample, 30);
    }
    let settled = false;
    const settle = (decoded: boolean) => {
      // A cancelled, superseded, or already-fired preparation must not arm.
      if (settled || this.prep !== prep || prep.state !== 'ready') return;
      settled = true;
      if (prep.bufferWaitTimer != null) {
        clearTimeout(prep.bufferWaitTimer);
        prep.bufferWaitTimer = null;
      }
      const planned = this.planFor(prep, decoded ? 'buffer' : 'media');
      if (prep.clockSampler != null) {
        clearInterval(prep.clockSampler);
        prep.clockSampler = null;
      }
      this.armPlannedEdge(prep, planned);
    };
    prep.bufferWaitTimer = setTimeout(() => settle(false), budgetMs);
    void buffers.ensureDecoded(prep.track).then(settle);
  }

  /** The outgoing deck's clock sample in its OWN frame: the buffer transport's
   * exact render-clock position when the deck plays a decoded buffer, the
   * element's presented position otherwise. */
  private outClock(
    outDeck: DeckId,
    outEl: HTMLAudioElement,
  ): {
    positionSeconds: number;
    durationSeconds: number;
    playbackRate: number;
    frame: 'element' | 'buffer';
  } {
    const buffers = this.host.buffers();
    if (buffers?.carrying(outDeck)) {
      const positionSeconds = buffers.positionSeconds(outDeck);
      const durationSeconds = buffers.durationSeconds(outDeck);
      if (positionSeconds != null && durationSeconds != null) {
        return {
          positionSeconds,
          durationSeconds,
          playbackRate: buffers.playbackRate(outDeck),
          frame: 'buffer',
        };
      }
    }
    return {
      positionSeconds: outEl.currentTime,
      durationSeconds: outEl.duration,
      playbackRate: outEl.playbackRate,
      frame: 'element',
    };
  }

  /** Plan the edge for one transport, or null when the inputs are gone
   * (racing teardown/exhaustion — stay `ready`; the threshold fires plain). */
  private planFor(prep: Preparation, transport: 'media' | 'buffer'): PlannedEdge | null {
    const engine = this.host.engine();
    const outDeck = this.host.activeDeck();
    const outEl = this.host.deckEl(outDeck);
    const outTrack = this.host.deckTrack(outDeck);
    const committed = this.host.committedKind(prep.deck);
    if (!engine || !engine.isActive || !outEl || !outTrack || !committed) return null;
    const clock = this.outClock(outDeck, outEl);
    const nowCtx = engine.now();
    // Mixed edges place a SAMPLE-ACCURATE buffer against the element clock:
    // refine the raw (quantized, always-late) read with the decode-wait
    // sample envelope. The raw read is a lower bound — never move backwards.
    if (transport === 'buffer' && clock.frame === 'element' && nowCtx != null) {
      const refined = upperEnvelopePositionSeconds(prep.clockSamples, nowCtx, clock.playbackRate);
      if (refined != null && refined > clock.positionSeconds) {
        clock.positionSeconds = refined;
      }
    }
    return planEdge({
      from: this.endpointOf(outTrack, this.host.committedKind(outDeck)),
      to: this.endpointOf(prep.track, committed),
      fromLoudness: loudnessOf(outTrack),
      toLoudness: loudnessOf(prep.track),
      // Buffer sources resample without pitch correction: always the tight cap.
      rateCapFraction:
        transport === 'buffer' ? UNPRESERVED_PITCH_RATE_CAP : engine.rateCapFraction(prep.deck),
      alignedSchedulingSupported: engine.alignedSchedulingSupported(),
      crossfadeSeconds: this.host.settings().crossfadeSeconds,
      outDurationSeconds: clock.durationSeconds,
      outPositionSeconds: clock.positionSeconds,
      outPlaybackRate: clock.playbackRate,
      nowContextTime: nowCtx,
      clockLatencySeconds: engine.clockLatencySeconds(),
      minLeadSeconds: MIN_ALIGN_LEAD_SECONDS,
      transport,
      outFrame: clock.frame,
      incomingTransport: transport === 'buffer' ? 'buffer' : 'element',
    });
  }

  /** Arm a planned edge: automation on the context clock, then the incoming
   * start — element pre-roll or sample-accurate buffer start. Every failure
   * degrades the DECISION (telemetry must never claim alignment for a plain
   * fade) and leaves playback on the element path, uninterrupted. */
  private armPlannedEdge(prep: Preparation, planned: PlannedEdge | null): void {
    if (!planned) return;
    prep.planned = planned;
    const engine = this.host.engine();
    const nowCtx = engine?.now();
    const aligned = planned.aligned;
    if (!aligned || !engine || nowCtx == null) return;
    const outDeck = this.host.activeDeck();
    const bufferIncoming = aligned.incomingTransport === 'buffer';

    // Degrade to the plain threshold path: the DECISION records the miss
    // (telemetry must never claim alignment), the incoming deck returns to
    // 1× audible-element state, and the prep stays `ready` for the threshold.
    const degradeToThreshold = () => {
      prep.planned = degradePlannedEdge(planned, 'schedule-missed');
      engine.setPlaybackRate(prep.deck, 1);
      if (bufferIncoming) engine.setDeckMediaAudible(prep.deck, true);
    };

    // In buffer mode the element is only the muted focus/Media-Session
    // carrier — gate it closed BEFORE anything can make it audible.
    if (bufferIncoming) engine.setDeckMediaAudible(prep.deck, false);
    engine.setPlaybackRate(prep.deck, aligned.incomingRate);
    const scheduled = engine.crossfade({
      from: outDeck,
      to: prep.deck,
      atContextTime: aligned.fadeStartContextTime,
      fadeSeconds: aligned.fadeSeconds,
      fromGainDb: planned.gains.fromDb,
      toGainDb: planned.gains.toDb,
      toSettleGainDb: soloLoudnessGainDb(loudnessOf(prep.track)),
    });
    if (!scheduled) {
      // The automation could not be armed (the engine parked everything).
      degradeToThreshold();
      return;
    }

    if (bufferIncoming) {
      const started =
        this.host
          .buffers()
          ?.startAtTime(
            prep.deck,
            prep.track.trackId,
            aligned.incomingStartContextTime,
            0,
            aligned.incomingRate,
          ) ?? false;
      if (!started) {
        // The graph refused the source: cancel the armed automation (settle
        // onto the active deck) and fall back to the element path — the
        // threshold fires a plain edge, uninterrupted.
        engine.hardCut(outDeck, soloLoudnessGainDb(loudnessOf(this.host.deckTrack(outDeck))));
        degradeToThreshold();
        return;
      }
      this.applyEvent(prep, { type: 'schedule' });
      // `source.start(when)` executes on the audio thread — sample-accurate by
      // construction; there is no start-miss window to guard.
      prep.actualStartContextTime = aligned.incomingStartContextTime;
      prep.measuredPhaseErrorMs = 0;
      // The carrier is an ELEMENT command: it lives on the presentation
      // timeline (= render + latency), or a long output pipeline would run it
      // ahead of the buffer it shadows.
      const carrierDelayMs = Math.max(
        0,
        (aligned.incomingStartContextTime + engine.clockLatencySeconds() - nowCtx) * 1000,
      );
      prep.startTimer = setTimeout(() => this.startCarrier(prep), carrierDelayMs);
      const commitDelayMs = Math.max(0, (aligned.presentationFadeStartContextTime - nowCtx) * 1000);
      prep.commitTimer = setTimeout(() => {
        if (this.prep === prep) this.commitEdge(prep);
      }, commitDelayMs);
      return;
    }

    this.applyEvent(prep, { type: 'schedule' });
    const delayMs = Math.max(0, (aligned.incomingStartContextTime - nowCtx) * 1000);
    prep.startTimer = setTimeout(() => this.startIncoming(prep), delayMs);
  }

  /** Roll the incoming deck's MUTED media element alongside its buffer: the
   * element is the Android focus/Media-Session carrier (Chrome guidance) —
   * best-effort; the audible audio is the buffer either way. */
  private startCarrier(prep: Preparation): void {
    if (this.prep !== prep || prep.state !== 'scheduled') return;
    void this.host
      .deckEl(prep.deck)
      ?.play()
      .catch(() => undefined);
  }

  /** Start the incoming element. Aligned edges: the muted pre-roll runs under a
   * START-MISS GUARD — automation is already armed on the audio thread, so a
   * `play()` that rejects, stays pending, or resolves too late must CANCEL the
   * scheduled fade instead of fading into silence; the logical handoff then
   * commits at the fade boundary. Plain edges arm their fade only once
   * `play()` actually resolved, and commit right there (their fade starts
   * immediately). */
  private startIncoming(prep: Preparation): void {
    const el = this.host.deckEl(prep.deck);
    const engine = this.host.engine();
    if (!el || !engine || this.prep !== prep) return;
    if (!this.host.startable(prep.track)) {
      this.cancel();
      return;
    }
    const aligned = prep.planned?.aligned ?? null;

    if (aligned) {
      const now = engine.now();
      const missAtMs =
        now != null
          ? Math.max(
              0,
              (aligned.incomingStartContextTime + ALIGNED_START_MISS_SECONDS - now) * 1000,
            )
          : ALIGNED_START_MISS_SECONDS * 1000;
      prep.guardTimer = setTimeout(() => {
        if (this.prep === prep && prep.state === 'scheduled') {
          this.fail(prep, { type: 'start-rejected' });
        }
      }, missAtMs);
    }

    el.play().then(
      () => {
        if (this.prep !== prep || prep.state !== 'scheduled') return;
        if (!aligned) {
          // Plain edge: the element is audibly running — arm the fade NOW and
          // commit (the fade boundary is now). If even the plain fade cannot
          // be scheduled, hard-cut INTO the incoming deck: an audible cut over
          // silence, and the telemetry reasons say why.
          const nowPlain = engine.now();
          if (nowPlain != null) {
            const ratePlain = el.playbackRate > 0 ? el.playbackRate : 1;
            prep.actualStartContextTime = nowPlain - el.currentTime / ratePlain;
          }
          const outDeck = this.host.activeDeck();
          const gains =
            prep.planned?.gains ??
            soloEdgeGains(loudnessOf(this.host.deckTrack(outDeck)), loudnessOf(prep.track));
          const faded = engine.crossfade({
            from: outDeck,
            to: prep.deck,
            atContextTime: null,
            fadeSeconds: this.host.settings().crossfadeSeconds,
            fromGainDb: gains.fromDb,
            toGainDb: gains.toDb,
            toSettleGainDb: soloLoudnessGainDb(loudnessOf(prep.track)),
          });
          if (!faded) {
            engine.hardCut(prep.deck, soloLoudnessGainDb(loudnessOf(prep.track)));
            if (prep.planned) prep.planned = degradePlannedEdge(prep.planned, 'schedule-missed');
          }
          this.commitEdge(prep);
          return;
        }
        if (prep.guardTimer != null) {
          clearTimeout(prep.guardTimer);
          prep.guardTimer = null;
        }
        const now = engine.now();
        if (now == null) {
          this.fail(prep, { type: 'start-rejected' });
          return;
        }
        const rate = el.playbackRate > 0 ? el.playbackRate : 1;
        prep.actualStartContextTime = now - el.currentTime / rate;
        prep.measuredPhaseErrorMs =
          (prep.actualStartContextTime - aligned.incomingStartContextTime) * 1000;
        if (Math.abs(prep.measuredPhaseErrorMs) > ALIGNED_START_MISS_SECONDS * 1000) {
          // The pre-roll really started, but too far off the plan to hold the
          // beat: cancel the armed automation, settle, degrade to sequential.
          this.fail(prep, { type: 'start-rejected' });
          return;
        }
        // PRE-ROLL PHASE CORRECTION: the pre-roll is inaudible until the fade
        // starts, so a measured start error inside the miss window is seeked
        // away — the incoming beats land back on the planned grid instead of
        // carrying the element's pipeline start latency into the overlap.
        // (Telemetry keeps the RAW start error: it reports where the start
        // landed; the observed-output measurement binds the corrected result.)
        const errorSeconds = prep.measuredPhaseErrorMs / 1000;
        if (Math.abs(errorSeconds) > PREROLL_CORRECTION_FLOOR_SECONDS) {
          el.currentTime = Math.max(0, el.currentTime + errorSeconds * rate);
          prep.actualStartContextTime = aligned.incomingStartContextTime;
        }
        // The logical handoff (cursor, `started` report, UI) belongs to the
        // moment the fade becomes AUDIBLE — the presentation time, not the
        // (latency-shifted) render time the automation was armed at.
        const commitDelayMs = Math.max(0, (aligned.presentationFadeStartContextTime - now) * 1000);
        prep.commitTimer = setTimeout(() => {
          if (this.prep === prep) this.commitEdge(prep);
        }, commitDelayMs);
      },
      () => {
        if (this.prep === prep && prep.state === 'scheduled') {
          this.fail(prep, { type: 'start-rejected' });
        }
      },
    );
  }

  /** The logical handoff at the fade boundary: hand control to the host and
   * emit the telemetry the real-time measurement job consumes. */
  private commitEdge(prep: Preparation): void {
    this.prep = null;
    this.clearTimers(prep);
    this.applyEvent(prep, { type: 'commit' });
    this.host.commit(prep.deck, prep.track, prep.idx, prep.queueWrapped);
    emitBlendEdge({ ...this.edgeDetail(prep), committed: true });
  }

  private endpointOf(track: PlayableTrack, committed: CommittedSourceKind | null): EdgeEndpoint {
    return {
      // An uncommitted source counts as a stream — never alignable.
      source: committed ?? 'stream',
      styleRevision: track.styleRevision,
      targetBpm: track.targetBpm,
      targetKey: track.targetKey,
      analysis: track.blendAnalysis,
    };
  }
}
