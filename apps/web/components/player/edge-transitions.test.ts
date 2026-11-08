import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerEngine } from './audio-engine';
import { EdgeTransitions, type EdgeTransitionHost } from './edge-transitions';
import type { BlendEdgeEventDetail, PlayableTrack } from './playable-track';

// The prepared-deck driver against a fake host: failure-path telemetry (no
// survivorship bias — every failed ATTEMPT emits exactly one degraded event),
// including the post-readiness source deaths that must release the prep slot
// for a retry, and the schedule-failure degrade when the engine cannot arm
// the automation.

interface FakeElement {
  currentTime: number;
  duration: number;
  playbackRate: number;
  paused: boolean;
  playResult: 'resolve' | 'reject';
}

function fakeEl(): FakeElement & HTMLAudioElement {
  const el = {
    currentTime: 0,
    duration: 30,
    playbackRate: 1,
    paused: true,
    playResult: 'resolve' as const,
    play() {
      el.paused = false;
      return el.playResult === 'resolve' ? Promise.resolve() : Promise.reject(new Error('blocked'));
    },
    pause() {
      el.paused = true;
    },
    load() {},
    removeAttribute() {},
  };
  return el as unknown as FakeElement & HTMLAudioElement;
}

function track(id: string): PlayableTrack {
  return {
    queueState: 'queued',
    vibeSwitchSetAside: false,
    queueItemId: `qi-${id}`,
    trackId: id,
    title: id,
    artist: null,
    originSessionTitle: null,
    durationSeconds: 30,
    coverImageId: null,
    genreTags: [],
    vocalMode: 'instrumental' as const,
    hasLyrics: false,
    downloadable: true,
    savedAt: null,
    favoritedAt: null,
    inCuratedPlaylist: false,
    assets: { final: `/api/audio/${id}?asset=final`, stream: null },
    styleRevision: 1,
    targetBpm: 120,
    targetKey: 'A minor',
    blendAnalysis: {
      version: 2,
      status: 'complete',
      bpm: 120,
      bpmSource: 'measured',
      bpmConfidence: 0.9,
      headBeatAnchorSeconds: 0.25,
      headBeatPeriodSeconds: 0.5,
      tailBeatAnchorSeconds: 0.25,
      tailBeatPeriodSeconds: 0.5,
      integratedLufs: -14,
      truePeakDb: -3,
    },
  };
}

interface Fixture {
  driver: EdgeTransitions;
  els: Record<'a' | 'b', FakeElement & HTMLAudioElement>;
  engine: {
    crossfadeCalls: number;
    crossfadeResult: boolean;
    hardCutCalls: Array<{ deck: string; gainDb: number }>;
    mediaAudible: Array<{ deck: string; audible: boolean }>;
  };
  host: EdgeTransitionHost;
  commits: string[];
  events: BlendEdgeEventDetail[];
  unloaded: string[];
}

function setup(): Fixture {
  const els = { a: fakeEl(), b: fakeEl() };
  const engineState = {
    crossfadeCalls: 0,
    crossfadeResult: true,
    hardCutCalls: [] as Array<{ deck: string; gainDb: number }>,
    mediaAudible: [] as Array<{ deck: string; audible: boolean }>,
  };
  // The context clock starts at 100 and advances with the (fake) timers, so
  // aligned pre-roll/commit timers observe consistent context times.
  const t0 = Date.now();
  const engine = {
    isActive: true,
    now: () => 100 + (Date.now() - t0) / 1000,
    rateCapFraction: () => 0.06,
    alignedSchedulingSupported: () => true,
    clockLatencySeconds: () => 0,
    setPlaybackRate: () => undefined,
    setDeckMediaAudible: (deck: 'a' | 'b', audible: boolean) => {
      engineState.mediaAudible.push({ deck, audible });
    },
    crossfade: () => {
      engineState.crossfadeCalls += 1;
      return engineState.crossfadeResult;
    },
    hardCut: (deck: 'a' | 'b', gainDb: number) => {
      engineState.hardCutCalls.push({ deck, gainDb });
    },
  } as unknown as PlayerEngine;

  const deckTracks: Record<'a' | 'b', PlayableTrack | null> = { a: track('out'), b: null };
  const commits: string[] = [];
  const unloaded: string[] = [];
  const host: EdgeTransitionHost = {
    deckEl: (deck) => els[deck],
    engine: () => engine,
    settings: () => ({ blendEnabled: true, crossfadeSeconds: 2 }),
    activeDeck: () => 'a',
    deckTrack: (deck) => deckTracks[deck],
    committedKind: () => 'final',
    loadDeck: () => true,
    unloadDeck: (deck) => {
      unloaded.push(deck);
    },
    nextTarget: () => ({ idx: 1, track: track('in') }),
    commit: (_deck, committed) => {
      commits.push(committed.trackId);
    },
    // Media-tier fixture default: no buffer transport (its own describe covers it).
    buffers: () => null,
    bufferEligible: () => false,
  };

  // Vitest runs in a node environment: give `emitBlendEdge` a window-shaped
  // EventTarget so the telemetry is observable (CustomEvent exists in Node).
  const events: BlendEdgeEventDetail[] = [];
  const windowShim = new EventTarget();
  (globalThis as { window?: EventTarget }).window = windowShim;
  windowShim.addEventListener('liedmotif:blend-edge', (event) => {
    events.push((event as CustomEvent<BlendEdgeEventDetail>).detail);
  });

  return {
    driver: new EdgeTransitions(host),
    els,
    engine: engineState,
    host,
    commits,
    events,
    unloaded,
  };
}

describe('EdgeTransitions failure paths', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { window?: EventTarget }).window;
  });

  /** Drive a preparation to READY (loaded + edge decided/scheduled). */
  function prepareToReady(f: Fixture, positionSeconds: number): void {
    f.els.a.currentTime = positionSeconds;
    f.driver.onTimeUpdate(f.els.a, 28); // fade start at 28 s (30 s track, 2 s fade)
    expect(f.driver.prepDeck()).toBe('b');
    f.driver.onDeckReady('b');
  }

  it('emits ONE prepare-failed event when a source dies after readiness (and frees the slot)', () => {
    const f = setup();
    // Position far from the fade: the plan cannot be honored yet, so the edge
    // stays READY (plain threshold) after the decision.
    prepareToReady(f, 27.8);
    f.driver.onDeckFailed('b');
    expect(f.events).toHaveLength(1);
    expect(f.events[0]?.tier).toBe('plain');
    expect(f.events[0]?.reasons).toContain('prepare-failed');
    // A failed attempt never claims a handoff — the chip must not adopt it.
    expect(f.events[0]?.committed).toBe(false);
    expect(f.unloaded).toContain('b');
    // The slot is RELEASED — a fresh preparation may retry immediately.
    expect(f.driver.prepDeck()).toBeNull();
  });

  it('emits ONE start-missed event when a SCHEDULED edge dies before handoff (and settles)', () => {
    const f = setup();
    // Early position: the aligned plan fits, so readiness schedules the edge.
    prepareToReady(f, 20);
    expect(f.engine.crossfadeCalls).toBe(1);
    f.driver.onDeckFailed('b');
    expect(f.events).toHaveLength(1);
    expect(f.events[0]?.reasons).toContain('start-missed');
    // cancel-schedule settles the graph onto the active deck.
    expect(f.engine.hardCutCalls.map((c) => c.deck)).toContain('a');
    expect(f.driver.prepDeck()).toBeNull();
  });

  it('degrades the DECISION to schedule-missed when the engine cannot arm the fade', () => {
    const f = setup();
    f.engine.crossfadeResult = false;
    prepareToReady(f, 20);
    // The aligned schedule failed: the prep stays READY for a plain threshold
    // fire, and the eventual commit must report plain + schedule-missed.
    f.els.a.currentTime = 28.2;
    f.driver.onTimeUpdate(f.els.a, 28); // plain threshold fires (crossfade fails again → hard cut)
    return vi.runAllTimersAsync().then(() => {
      expect(f.commits).toEqual(['in']);
      expect(f.events).toHaveLength(1);
      expect(f.events[0]?.tier).toBe('plain');
      expect(f.events[0]?.reasons).toContain('schedule-missed');
      // The plain-fade failure fell back to an audible hard cut INTO the deck.
      expect(f.engine.hardCutCalls.map((c) => c.deck)).toContain('b');
    });
  });

  it('deliberate cancellation emits NO telemetry (not a failed attempt)', () => {
    const f = setup();
    prepareToReady(f, 20);
    f.driver.cancel();
    expect(f.events).toHaveLength(0);
    expect(f.driver.prepDeck()).toBeNull();
  });

  it('scheduledFor answers true only for an ARMED preparation of that queue item (loop toggle-off)', () => {
    const f = setup();
    expect(f.driver.scheduledFor('qi-in')).toBe(false);
    // READY but not yet armed (position too close for the aligned plan): false.
    prepareToReady(f, 27.8);
    expect(f.driver.scheduledFor('qi-in')).toBe(false);
    f.driver.cancel();
    // ARMED: true for the prepared item only.
    prepareToReady(f, 20);
    expect(f.driver.scheduledFor('qi-in')).toBe(true);
    expect(f.driver.scheduledFor('qi-out')).toBe(false);
  });

  it('a LOOP SEAM (target = the outgoing track itself) schedules beat-aligned like any edge', async () => {
    const f = setup();
    // Repeat-one: the transition target IS the audible track — the other deck
    // re-pins the same final and the seam schedules head grid against tail grid.
    const pinned = f.host.deckTrack('a')!;
    f.host.nextTarget = () => ({ idx: 0, track: pinned });
    prepareToReady(f, 20);
    expect(f.engine.crossfadeCalls).toBe(1);
    await vi.runAllTimersAsync();
    // The handoff commits the SAME track (one `started` per pass) at the
    // aligned tier — same identity + analysis on both endpoints by definition.
    expect(f.commits).toEqual([pinned.trackId]);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]?.tier).toBe('beat-aligned');
    expect(f.events[0]?.reasons).toEqual([]);
    expect(f.events[0]?.committed).toBe(true);
  });

  it('a LATE element pre-roll start inside the miss window is SEEKED back onto the planned grid', async () => {
    const f = setup();
    const originalPlay = f.els.b.play.bind(f.els.b);
    f.els.b.play = () => {
      // The pre-roll start lands 50 ms late (timer jank / pipeline settle) —
      // measurable via currentTime, inside the 120 ms miss window.
      vi.setSystemTime(Date.now() + 50);
      return originalPlay();
    };
    prepareToReady(f, 20);
    await vi.runAllTimersAsync();
    expect(f.commits).toEqual(['in']);
    // The measured error was seeked away during the muted pre-roll: telemetry
    // keeps the RAW start error, the effective start is the planned one, and
    // the element jumped forward by the error.
    expect(f.els.b.currentTime).toBeCloseTo(0.05, 3);
    expect(f.events[0]?.tier).toBe('beat-aligned');
    expect(f.events[0]?.phaseErrorMs).toBeCloseTo(50, 0);
    expect(f.events[0]?.actualStartContextTime).toBeCloseTo(107.5, 3);
  });
});

describe('EdgeTransitions buffer transport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { window?: EventTarget }).window;
  });

  interface FakeBuffers {
    decodeResult: boolean;
    startResult: boolean;
    decoded: string[];
    starts: Array<{ deck: string; trackId: string; when: number; offset: number; rate: number }>;
    stops: string[];
    /** A deck actively playing a decoded buffer (its exact transport clock). */
    active: { deck: 'a' | 'b'; position: number; duration: number; rate: number } | null;
  }

  /** A media-fixture setup upgraded to a buffer-eligible session. */
  function setupBuffer(): Fixture & { buffers: FakeBuffers } {
    const f = setup();
    const buffers: FakeBuffers = {
      decodeResult: true,
      startResult: true,
      decoded: [],
      starts: [],
      stops: [],
      active: null,
    };
    const fake = {
      supported: () => true,
      carrying: (deck: string) => buffers.active?.deck === deck,
      positionSeconds: (deck: string) =>
        buffers.active?.deck === deck ? buffers.active.position : null,
      durationSeconds: (deck: string) =>
        buffers.active?.deck === deck ? buffers.active.duration : null,
      playbackRate: (deck: string) => (buffers.active?.deck === deck ? buffers.active.rate : 1),
      ensureDecoded: (t: { trackId: string }) => {
        buffers.decoded.push(t.trackId);
        return Promise.resolve(buffers.decodeResult);
      },
      startAtTime: (deck: string, trackId: string, when: number, offset: number, rate: number) => {
        if (buffers.startResult) buffers.starts.push({ deck, trackId, when, offset, rate });
        return buffers.startResult;
      },
      stop: (deck: string) => {
        buffers.stops.push(deck);
      },
    };
    f.host.buffers = () => fake as never;
    f.host.bufferEligible = () => true;
    return Object.assign(f, { buffers });
  }

  function prepareToReady(f: Fixture, positionSeconds: number): void {
    f.els.a.currentTime = positionSeconds;
    f.driver.onTimeUpdate(f.els.a, 28);
    f.driver.onDeckReady('b');
  }

  it('arms a beat-locked edge: decode-wait, sample-accurate source start, muted carrier, commit', async () => {
    const f = setupBuffer();
    prepareToReady(f, 20);
    // Decode-wait: nothing armed until the incoming final decoded.
    expect(f.engine.crossfadeCalls).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.buffers.decoded).toEqual(['in']);
    expect(f.engine.crossfadeCalls).toBe(1);
    // Incoming starts on the RENDER clock: fade beat 27.75 at ctx 107.75 minus
    // the 0.25 s head-anchor lead; the carrier element is gated silent first.
    expect(f.buffers.starts).toEqual([
      { deck: 'b', trackId: 'in', when: 107.5, offset: 0, rate: 1 },
    ]);
    expect(f.engine.mediaAudible).toEqual([{ deck: 'b', audible: false }]);

    await vi.runAllTimersAsync();
    // The muted carrier pre-rolled alongside the buffer.
    expect(f.els.b.paused).toBe(false);
    expect(f.commits).toEqual(['in']);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]?.tier).toBe('beat-locked');
    expect(f.events[0]?.phaseErrorMs).toBe(0);
    expect(f.events[0]?.actualStartContextTime).toBeCloseTo(107.5);
  });

  it('a failed decode falls back to the ELEMENT deck plan, uninterrupted (beat-aligned)', async () => {
    const f = setupBuffer();
    f.buffers.decodeResult = false;
    prepareToReady(f, 20);
    await Promise.resolve();
    await Promise.resolve();
    // Media plan armed instead; the buffer transport never started a source
    // and the element was never muted.
    expect(f.engine.crossfadeCalls).toBe(1);
    expect(f.buffers.starts).toEqual([]);
    expect(f.engine.mediaAudible).toEqual([]);
    await vi.runAllTimersAsync();
    expect(f.commits).toEqual(['in']);
    expect(f.events[0]?.tier).toBe('beat-aligned');
  });

  it('cancellation during the decode-wait arms nothing and emits nothing', async () => {
    const f = setupBuffer();
    prepareToReady(f, 20);
    f.driver.cancel();
    await vi.runAllTimersAsync();
    expect(f.engine.crossfadeCalls).toBe(0);
    expect(f.buffers.starts).toEqual([]);
    expect(f.events).toHaveLength(0);
  });

  it('a refused source start settles the armed automation and restores the element path', async () => {
    const f = setupBuffer();
    f.buffers.startResult = false;
    prepareToReady(f, 20);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.engine.crossfadeCalls).toBe(1);
    // The armed automation was cancelled (settle onto the active deck) and the
    // carrier gate reopened for the element fallback.
    expect(f.engine.hardCutCalls.map((c) => c.deck)).toContain('a');
    expect(f.engine.mediaAudible).toEqual([
      { deck: 'b', audible: false },
      { deck: 'b', audible: true },
    ]);
    // The prep stays READY: the threshold fires a plain edge that must report
    // the degrade truthfully.
    f.els.a.currentTime = 28.2;
    f.driver.onTimeUpdate(f.els.a, 28);
    await vi.runAllTimersAsync();
    expect(f.commits).toEqual(['in']);
    expect(f.events[0]?.tier).toBe('plain');
    expect(f.events[0]?.reasons).toContain('schedule-missed');
  });

  it('a BUFFER loop seam re-arms the pinned track: decode hits the cache, second source starts', async () => {
    const f = setupBuffer();
    // Repeat-one on buffer transport: deck a plays the pinned track's decoded
    // buffer; the seam decodes the SAME trackId (a cache hit in the real
    // transport) and schedules a second one-shot source on the other deck.
    const pinned = f.host.deckTrack('a')!;
    f.host.nextTarget = () => ({ idx: 0, track: pinned });
    f.buffers.active = { deck: 'a', position: 20, duration: 30, rate: 1 };
    f.driver.onTimeUpdate(f.els.a, 28);
    f.driver.onDeckReady('b');
    await Promise.resolve();
    await Promise.resolve();
    expect(f.buffers.decoded).toEqual([pinned.trackId]);
    expect(f.buffers.starts.map((s) => ({ deck: s.deck, trackId: s.trackId }))).toEqual([
      { deck: 'b', trackId: pinned.trackId },
    ]);
    await vi.runAllTimersAsync();
    expect(f.commits).toEqual([pinned.trackId]);
    expect(f.events[0]?.tier).toBe('beat-locked');
  });

  it('the preparation trigger runs from the BUFFER clock when the carrier is stale', () => {
    const f = setupBuffer();
    // Deck a plays its decoded buffer at 20.5 s while the parked/dead carrier
    // element still reads 0 — the trigger (and the readiness deadline) must
    // come from the transport's exact clock, or a dead carrier would silently
    // stall every following transition.
    f.buffers.active = { deck: 'a', position: 20.5, duration: 30, rate: 1 };
    f.els.a.currentTime = 0;
    f.driver.onTimeUpdate(f.els.a, 28);
    expect(f.driver.prepDeck()).toBe('b');
  });

  it('an untrusted clock mapping never becomes a buffer candidate', async () => {
    const f = setupBuffer();
    (
      f.host.engine() as unknown as { alignedSchedulingSupported: () => boolean }
    ).alignedSchedulingSupported = () => false;
    prepareToReady(f, 20);
    await Promise.resolve();
    expect(f.buffers.decoded).toEqual([]);
  });
});
