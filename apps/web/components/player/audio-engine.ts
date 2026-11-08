// Thin Web Audio wiring for the live blend.
//
// All DECISIONS live in @liedmotif/shared/player as pure, unit-tested functions
// (edge policy, mutual loudness, beat scheduling), and the graph topology +
// click-safe automation live in `blend-graph.ts`, shared with the offline DSP
// harness that gates them. This class is only the DOM plumbing: it binds the two
// persistent <audio> elements into deck chains, maps deck ids to chains, and
// no-ops wherever `AudioContext` is unavailable (SSR, tests, older browsers) —
// the player then falls back to strictly sequential playback through the bare
// elements (never a blend, never double audio).
//
// Audio is same-origin (`/api/audio/...`), so `MediaElementAudioSourceNode`
// outputs real samples rather than the silence CORS media yields — the
// precondition that makes browser blending viable.

import { clamp, PRESERVED_PITCH_RATE_CAP, UNPRESERVED_PITCH_RATE_CAP } from '@liedmotif/shared';
import {
  attemptCrossfadeAutomation,
  createDeckChain,
  createMasterBus,
  hardCutOrEmergency,
  stepParam,
  type DeckChain,
} from './blend-graph';

export type DeckId = 'a' | 'b';

// Re-exported for existing consumers; the constant lives in shared (it is the
// pitch policy's one ±1.5% number: unpreserved media decks AND buffer decks).
export { UNPRESERVED_PITCH_RATE_CAP };

interface DeckNodes {
  el: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  chain: DeckChain;
  /** Gate between the element source and the chain: 1 in element mode, 0 while
   *  the deck plays a decoded buffer and the element is only the muted
   *  focus/Media-Session carrier. */
  mediaGate: GainNode;
}

interface AudioContextWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

/** The WebKit-prefixed variant of `preservesPitch` (not in lib.dom). */
interface WebkitPitchElement {
  webkitPreservesPitch?: boolean;
}

function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as AudioContextWindow;
  return window.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Whether the element supports pitch-preserving rate changes (incl. WebKit).
 * `preservesPitch` is typed in lib.dom but missing at runtime on older engines —
 * hence the runtime typeof checks (feature detection, no UA sniffing). */
export function preservesPitchSupported(el: HTMLAudioElement): boolean {
  return (
    typeof el.preservesPitch === 'boolean' ||
    typeof (el as WebkitPitchElement).webkitPreservesPitch === 'boolean'
  );
}

/** One scheduled crossfade edge, in engine terms (all decisions already made). */
export interface EngineCrossfade {
  from: DeckId;
  to: DeckId;
  /** Absolute context time the fade starts; null → now (plain immediate edge). */
  atContextTime: number | null;
  fadeSeconds: number;
  /** Mutual-target loudness gains for this edge (dB per deck). */
  fromGainDb: number;
  toGainDb: number;
  /** The incoming deck's solo gain, restored after the overlap. */
  toSettleGainDb: number;
}

/**
 * The two-deck Web Audio graph. Construct once per player mount, `attach` the
 * two <audio> elements, then drive `hardCut` (cold-start entry, cancellation
 * settle) and `crossfade` (scheduled or immediate edges). Everything no-ops when
 * Web Audio is absent.
 */
export class PlayerEngine {
  private ctx: AudioContext | null = null;
  private decks: Record<DeckId, DeckNodes | null> = { a: null, b: null };
  /** The shared output bus gain — the whole-session volume the cross-session
   * handoff fades (deck-level fade gains keep running underneath it). */
  private master: GainNode | null = null;
  private readonly supported = audioContextCtor() !== null;
  // A context kept ALIVE after a partial attach failure: a created
  // MediaElementAudioSourceNode permanently reroutes its element through its
  // context, so closing it would silence the element for good (see attach).
  private orphanCtx: AudioContext | null = null;
  // A context created (and unlocked) by `prime` inside a user gesture, BEFORE
  // the deck elements exist — `attach` adopts it instead of constructing one
  // (session-start autoplay).
  private primedCtx: AudioContext | null = null;
  // Decks waiting for a primed context to finish resuming. No media source is
  // created until the context runs, so the elements stay audible meanwhile.
  private pendingElements: readonly [HTMLAudioElement, HTMLAudioElement] | null = null;
  // The latest deck selection made while attachment waits for context resume.
  private pendingHardCut: { deck: DeckId; soloGainDb: number } | null = null;

  /** True when a real audio graph is available (false under SSR/jsdom/old browsers). */
  get isSupported(): boolean {
    return this.supported;
  }

  /** True once `attach` actually built a graph (stricter than `isSupported`). */
  get isActive(): boolean {
    return this.ctx !== null;
  }

  /** Lazily build the graph and bind the two <audio> elements (idempotent).
   * The graph is published only once BOTH decks attached: a deck chain starts
   * at fade gain 0, so a half-built graph would leave the first element
   * rerouted into a muted dead end while the engine claims to be inactive. On
   * a partial failure the created source is rewired straight to the
   * destination at unity (the element stays audible for the sequential
   * fallback) and the context is kept alive — closing it would silence the
   * element permanently. */
  attach(elA: HTMLAudioElement, elB: HTMLAudioElement): void {
    if (!this.supported || this.ctx) return;
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    let ctx: AudioContext | null = null;
    let deckA: DeckNodes | null = null;
    try {
      // A primed context (created + unlocked inside the start-session gesture)
      // is adopted here so the graph rides its already-granted activation.
      ctx = this.primedCtx ?? new Ctor();
      // Creating a MediaElementAudioSourceNode reroutes the element into this
      // context permanently. If the browser refused the unlock, attaching
      // would turn a playable element into silence. Keep the unused context
      // only for cleanup/retry and leave both elements on their audible,
      // sequential fallback path.
      if (ctx.state !== 'running') {
        this.primedCtx = ctx;
        this.pendingElements = [elA, elB];
        void this.resume();
        return;
      }
      this.primedCtx = null;
      this.pendingElements = null;
      const bus = createMasterBus(ctx);
      deckA = this.buildDeck(ctx, bus.master, elA);
      const deckB = this.buildDeck(ctx, bus.master, elB);
      this.ctx = ctx;
      this.decks.a = deckA;
      this.decks.b = deckB;
      this.master = bus.master;
      const parkedHardCut = this.pendingHardCut;
      if (parkedHardCut) this.hardCut(parkedHardCut.deck, parkedHardCut.soloGainDb);
    } catch {
      // A second MediaElementAudioSourceNode on the same element, or a blocked
      // context. Unblended, but every element must stay AUDIBLE.
      this.ctx = null;
      this.decks = { a: null, b: null };
      if (ctx && deckA) {
        try {
          deckA.source.disconnect();
          deckA.source.connect(ctx.destination);
          this.orphanCtx = ctx;
        } catch {
          // The element may be silent here; nothing safer is available.
        }
      } else if (ctx) {
        void ctx.close().catch(() => undefined);
      }
    }
  }

  private buildDeck(ctx: AudioContext, destination: AudioNode, el: HTMLAudioElement): DeckNodes {
    const chain = createDeckChain(ctx, destination);
    const mediaGate = ctx.createGain();
    mediaGate.gain.value = 1;
    const source = ctx.createMediaElementSource(el);
    source.connect(mediaGate).connect(chain.input);
    return { el, source, chain, mediaGate };
  }

  /**
   * Create + unlock the AudioContext inside a user gesture BEFORE the deck
   * elements exist (session-start autoplay): the start-session
   * click is the gesture, but the player mounts only after the create request
   * resolves. `attach` later builds the graph on this context. Idempotent;
   * no-ops where Web Audio is absent or a graph already exists.
   */
  prime(): void {
    if (!this.supported || this.ctx || this.primedCtx) return;
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    try {
      this.primedCtx = new Ctor();
      void this.primedCtx.resume().catch(() => undefined);
    } catch {
      this.primedCtx = null;
    }
  }

  /** Resume the context after a user gesture (autoplay policies) — including
   * a primed-but-unattached context, and the orphan context of a partially
   * failed attach, whose element plays through it and would otherwise stay
   * silent if it started (or was later) suspended. */
  async resume(): Promise<void> {
    for (const ctx of [this.ctx, this.primedCtx, this.orphanCtx]) {
      if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') {
        await ctx.resume().catch(() => undefined);
      }
    }
    const pending = this.pendingElements;
    if (pending && this.primedCtx?.state === 'running') {
      this.attach(...pending);
    }
  }

  /** The AudioContext clock, or null without a graph. */
  now(): number | null {
    return this.ctx ? this.ctx.currentTime : null;
  }

  /**
   * Whether beat-aligned scheduling may run at all: the media→context clock
   * mapping is only trustworthy where the context exposes `outputLatency`
   * (WebKit's gaps around `outputLatency`/scheduling are exactly why WebKit
   * degrades to unaligned). Feature detection, no
   * UA sniffing; false ⇒ every edge is plain (`timing-unsupported`).
   */
  alignedSchedulingSupported(): boolean {
    return this.ctx != null && typeof this.ctx.outputLatency === 'number';
  }

  /**
   * The full render→speaker latency of the graph (`baseLatency` +
   * `outputLatency`, where exposed): the scheduler arms automation this much
   * EARLIER so fades land on the audible media position (the media→
   * context mapping uses rate + baseLatency/outputLatency).
   */
  clockLatencySeconds(): number {
    if (!this.ctx) return 0;
    const base = typeof this.ctx.baseLatency === 'number' ? this.ctx.baseLatency : 0;
    const output = typeof this.ctx.outputLatency === 'number' ? this.ctx.outputLatency : 0;
    return base + output;
  }

  /**
   * The live AudioContext, for the BUFFER TRANSPORT only (decode, source
   * creation, the exact clock). Everything element/graph-side stays
   * behind the engine's own methods.
   */
  context(): AudioContext | null {
    return this.ctx;
  }

  /** Where a deck's buffer source connects (the head of its processing chain,
   *  parallel to the gated element source). Null without a graph. */
  deckInput(deck: DeckId): AudioNode | null {
    return this.decks[deck]?.chain.input ?? null;
  }

  /**
   * Gate the deck's MEDIA ELEMENT path: audible in element mode, muted while
   * the deck plays a decoded buffer and the element is only the focus/
   * Media-Session carrier (Chrome's Android guidance: keep a media element in
   * the chain). Click-safe step, never a jump.
   */
  setDeckMediaAudible(deck: DeckId, audible: boolean): void {
    const nodes = this.decks[deck];
    if (!nodes || !this.ctx) return;
    const gainValue = audible ? 1 : 0;
    try {
      stepParam(nodes.mediaGate.gain, gainValue, this.ctx.currentTime);
    } catch {
      // Automation primitives can throw (engine failure paths); a WebIDL
      // attribute set cannot — audible-and-instant beats silent-and-elegant.
      nodes.mediaGate.gain.value = gainValue;
    }
  }

  /**
   * AudioContext interruption/suspension recovery:
   * a phone call, route change, or background eviction can suspend the context
   * mid-buffer-playback with no element event to notice it. Resume on
   * `statechange`, on the page becoming visible, and on the next user gesture —
   * only while `shouldResume()` (the user still wants playback). Returns the
   * unbind cleanup.
   */
  bindInterruptionRecovery(shouldResume: () => boolean): () => void {
    // An attach waiting for a suspended context adopts this same primed
    // context as its graph, so recovery bound before the graph exists stays valid.
    const ctx = this.ctx ?? this.primedCtx;
    if (!ctx || typeof ctx.addEventListener !== 'function') return () => undefined;
    const tryResume = () => {
      // 'interrupted' is a non-standard in-the-wild state (iOS); anything that
      // is not running while the user wants playback is worth a resume attempt.
      if (shouldResume() && ctx.state !== 'running' && ctx.state !== 'closed') {
        void ctx.resume().catch(() => undefined);
      }
    };
    ctx.addEventListener('statechange', tryResume);
    const hasDocument =
      typeof document !== 'undefined' && typeof document.addEventListener === 'function';
    const hasWindow =
      typeof window !== 'undefined' && typeof window.addEventListener === 'function';
    const onVisible = () => {
      if (document.visibilityState === 'visible') tryResume();
    };
    if (hasDocument) document.addEventListener('visibilitychange', onVisible);
    if (hasWindow) {
      window.addEventListener('pointerdown', tryResume, true);
      window.addEventListener('keydown', tryResume, true);
    }
    return () => {
      ctx.removeEventListener('statechange', tryResume);
      if (hasDocument) document.removeEventListener('visibilitychange', onVisible);
      if (hasWindow) {
        window.removeEventListener('pointerdown', tryResume, true);
        window.removeEventListener('keydown', tryResume, true);
      }
    };
  }

  /**
   * The rate-nudge cap for a deck under the pitch policy: ±6% when the element
   * time-stretches (`preservesPitch`), ±1.5% when a rate change would shift pitch.
   */
  rateCapFraction(deck: DeckId): number {
    const el = this.decks[deck]?.el;
    return el && preservesPitchSupported(el)
      ? PRESERVED_PITCH_RATE_CAP
      : UNPRESERVED_PITCH_RATE_CAP;
  }

  /** Apply a rate nudge (already policy-capped) with pitch preservation on. */
  setPlaybackRate(deck: DeckId, rate: number): void {
    const el = this.decks[deck]?.el;
    if (!el) return;
    if (typeof el.preservesPitch === 'boolean') el.preservesPitch = true;
    const webkit = el as WebkitPitchElement;
    if (typeof webkit.webkitPreservesPitch === 'boolean') webkit.webkitPreservesPitch = true;
    el.playbackRate = clamp(rate, 1 - PRESERVED_PITCH_RATE_CAP, 1 + PRESERVED_PITCH_RATE_CAP);
  }

  /**
   * Make `deck` the only audible deck at `soloGainDb` loudness (cold-start
   * entry, error recovery, and the settle path after a cancelled edge). One
   * atomic call: passing the loudness here (instead of a separate step) is what
   * keeps the hard cut from cancelling its own gain. Click-safe, never a jump.
   */
  hardCut(deck: DeckId, soloGainDb: number): void {
    const ctx = this.ctx;
    if (!ctx) {
      this.pendingHardCut = { deck, soloGainDb };
      return;
    }
    this.pendingHardCut = null;
    const chains: DeckChain[] = [];
    let active: DeckChain | null = null;
    for (const id of ['a', 'b'] as const) {
      const nodes = this.decks[id];
      if (!nodes) continue;
      chains.push(nodes.chain);
      if (id === deck) active = nodes.chain;
      // Reset only the ABANDONED deck's rate: the surviving deck may carry a
      // legitimate nudge from ITS OWN aligned edge — a cancel-settle (queue
      // replacement, pause) must not change the audible track's tempo
      // mid-play. New loads set their own rate explicitly (DeckSources.begin).
      if (id !== deck) nodes.el.playbackRate = 1;
    }
    if (!active) return;
    // The shared recovery operation: click-safe cut, or — when even those
    // primitives throw — the emergency direct-value cut (non-throwing by
    // construction; see blend-graph).
    hardCutOrEmergency(chains, active, ctx.currentTime, soloGainDb);
  }

  /**
   * Set the whole graph's output level (the cross-session handoff's fade
   * handle — deck-level blend automation keeps running underneath). Click-safe
   * step. Returns false without a graph, so the caller can fall back to
   * element volume for the sequential/unblended path.
   */
  setMasterGain(value: number): boolean {
    if (!this.ctx || !this.master) return false;
    try {
      stepParam(this.master.gain, value, this.ctx.currentTime);
    } catch {
      this.master.gain.value = value;
    }
    return true;
  }

  /**
   * Schedule (or immediately start) one equal-power crossfade with bass-swap and
   * the edge's mutual-target loudness gains. The element-side work (src, play,
   * rate) is the controller's job; this only drives the graph automation.
   *
   * Returns false when the automation could NOT be scheduled (an AudioParam
   * call threw): every touched parameter is parked at its current value — the
   * outgoing deck keeps playing audibly, nothing half-scheduled remains armed —
   * and the CALLER must degrade the edge (settle + sequential advance or a hard
   * cut), never proceed as if the fade were running.
   */
  crossfade(params: EngineCrossfade): boolean {
    const ctx = this.ctx;
    const from = this.decks[params.from];
    const to = this.decks[params.to];
    if (!ctx || !from || !to) return false;
    const at = Math.max(params.atContextTime ?? ctx.currentTime, ctx.currentTime);
    return attemptCrossfadeAutomation(
      from.chain,
      to.chain,
      {
        atContextTime: at,
        fadeSeconds: params.fadeSeconds,
        fromGainDb: params.fromGainDb,
        toGainDb: params.toGainDb,
        toSettleGainDb: params.toSettleGainDb,
      },
      ctx.currentTime,
    );
  }

  /** Tear down the graph and release the context. */
  dispose(): void {
    for (const id of ['a', 'b'] as const) {
      const nodes = this.decks[id];
      if (nodes) {
        try {
          nodes.source.disconnect();
          nodes.mediaGate.disconnect();
          nodes.chain.bass.disconnect();
          nodes.chain.loud.disconnect();
          nodes.chain.fade.disconnect();
        } catch {
          // already disconnected
        }
      }
      this.decks[id] = null;
    }
    if (this.ctx) void this.ctx.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
    if (this.orphanCtx) void this.orphanCtx.close().catch(() => undefined);
    this.orphanCtx = null;
    if (this.primedCtx) void this.primedCtx.close().catch(() => undefined);
    this.primedCtx = null;
    this.pendingElements = null;
    this.pendingHardCut = null;
  }
}
