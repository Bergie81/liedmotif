import { describe, expect, it, vi } from 'vitest';
import { bindDeckLifecycle, type DeckLifecyclePorts } from './deck-lifecycle';
import type { DeckSources } from './deck-sources';
import type { EdgeTransitions } from './edge-transitions';
import type { PlayableTrack } from './playable-track';

// The deck event lifecycle at the DECISION level:
// sequential fallbacks (blending off / no graph) must NEVER touch the
// transition driver from timeupdate — `ended` advances; and a stale error task
// from a superseded load attempt (no live element error) must exit without
// reaching the failure paths.

interface FakeEl {
  listeners: Map<string, () => void>;
  currentTime: number;
  duration: number;
  playbackRate: number;
  error: MediaError | null;
  paused: boolean;
}

function fakeEl(): FakeEl & HTMLAudioElement {
  const el = {
    listeners: new Map<string, () => void>(),
    currentTime: 5,
    duration: 30,
    playbackRate: 1,
    error: { code: 4 } as MediaError,
    paused: false,
    addEventListener(type: string, fn: () => void) {
      el.listeners.set(type, fn);
    },
    removeEventListener(type: string) {
      el.listeners.delete(type);
    },
    pause() {
      el.paused = true;
    },
  };
  return el as unknown as FakeEl & HTMLAudioElement;
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
    blendAnalysis: null,
  };
}

function setup(over: Partial<DeckLifecyclePorts> = {}) {
  const els = { a: fakeEl(), b: fakeEl() };
  const transitions = {
    onTimeUpdate: vi.fn(),
    onDeckReady: vi.fn(),
    onDeckFailed: vi.fn(() => false),
  } as unknown as EdgeTransitions;
  const sources = {
    commitOnReady: vi.fn(() => true),
    stepDown: vi.fn(() => false),
    clear: vi.fn(),
  } as unknown as DeckSources;
  const ports: DeckLifecyclePorts = {
    deckEl: (deck) => els[deck],
    activeDeck: () => 'a',
    deckTrack: (deck) => (deck === 'a' ? track('active') : null),
    clearDeckTrack: vi.fn(),
    sources: () => sources,
    transitions: () => transitions,
    bufferCarrying: () => false,
    blendActive: () => true,
    crossfadeSeconds: () => 6,
    wantPlay: () => true,
    report: vi.fn(),
    advance: vi.fn(),
    advanceOffFailure: vi.fn(),
    resumePlay: vi.fn(),
    unloadDeck: vi.fn(),
    onSourceCommitted: vi.fn(),
    ...over,
  };
  const unbind = bindDeckLifecycle({ a: els.a, b: els.b }, ports);
  return { els, ports, transitions, sources, unbind };
}

describe('bindDeckLifecycle', () => {
  it('drives the transition trigger from the ACTIVE deck timeupdate when blending', () => {
    const { els, transitions } = setup();
    els.a.listeners.get('timeupdate')!();
    expect(transitions.onTimeUpdate).toHaveBeenCalledTimes(1);
  });

  it('notifies the controller of every source COMMIT (the loop toggle gate reads it)', () => {
    const { els, ports, sources } = setup();
    els.a.listeners.get('canplay')!();
    expect(ports.onSourceCommitted).toHaveBeenCalledWith('a');
    // A canplay that commits nothing (same-source readiness echo) stays silent.
    vi.mocked(sources.commitOnReady).mockReturnValue(false);
    els.b.listeners.get('canplay')!();
    expect(ports.onSourceCommitted).not.toHaveBeenCalledWith('b');
  });

  it('a PAUSED element timeupdate never drives the transition trigger (pause/seek echoes)', () => {
    // Pausing and seeking both fire `timeupdate` on a paused element; its
    // position is frozen, so a preparation begun off it could even ARM an
    // audible buffer start against a paused session (the
    // paused lock-screen scrub makes this reachable routinely).
    const { els, transitions } = setup();
    els.a.paused = true;
    els.a.listeners.get('timeupdate')!();
    expect(transitions.onTimeUpdate).not.toHaveBeenCalled();
  });

  it('NEVER prepares when blending is off — strictly sequential (unit for the fallback path)', () => {
    const { els, transitions } = setup({ blendActive: () => false });
    els.a.listeners.get('timeupdate')!();
    expect(transitions.onTimeUpdate).not.toHaveBeenCalled();
    // `ended` still advances sequentially.
    els.a.listeners.get('ended')!();
    expect(transitions.onTimeUpdate).not.toHaveBeenCalled();
  });

  it('advances on ended for the active deck; releases a non-active deck instead', () => {
    const { els, ports } = setup({
      deckTrack: (deck) => (deck === 'a' ? track('active') : track('tail')),
    });
    els.a.listeners.get('ended')!();
    expect(ports.advance).toHaveBeenCalledTimes(1);
    els.b.listeners.get('ended')!();
    expect(ports.advance).toHaveBeenCalledTimes(1); // unchanged
    expect(ports.clearDeckTrack).toHaveBeenCalledWith('b');
    expect(ports.report).toHaveBeenCalledWith('ended', expect.anything(), expect.anything());
  });

  it('a STALE error (no live element error) exits before any failure path', () => {
    const { els, ports, transitions, sources } = setup();
    els.a.error = null; // the load algorithm nulled the previous attempt's error
    els.a.listeners.get('error')!();
    expect(sources.stepDown).not.toHaveBeenCalled();
    expect(transitions.onDeckFailed).not.toHaveBeenCalled();
    expect(ports.report).not.toHaveBeenCalled();
    expect(ports.advanceOffFailure).not.toHaveBeenCalled();
  });

  it('a real active-deck error walks the ladder, then reports failed and advances', () => {
    const { els, ports, sources } = setup();
    els.a.listeners.get('error')!();
    expect(sources.stepDown).toHaveBeenCalledWith('a');
    expect(ports.report).toHaveBeenCalledWith('failed', expect.anything(), null);
    expect(ports.advanceOffFailure).toHaveBeenCalledTimes(1);
  });

  it('unbind removes every listener', () => {
    const { els, unbind } = setup();
    unbind();
    expect(els.a.listeners.size).toBe(0);
    expect(els.b.listeners.size).toBe(0);
  });

  it('a buffer-carrying deck treats element `ended` as a carrier echo: park, never advance', () => {
    const { els, ports } = setup({ bufferCarrying: (deck) => deck === 'a' });
    els.a.listeners.get('ended')!();
    expect(ports.advance).not.toHaveBeenCalled();
    expect(ports.report).not.toHaveBeenCalled();
    expect(els.a.paused).toBe(true);
  });

  it('a buffer-carrying deck ignores carrier element errors (audio is the buffer)', () => {
    const { els, ports, sources } = setup({ bufferCarrying: (deck) => deck === 'a' });
    els.a.listeners.get('error')!();
    expect(sources.stepDown).not.toHaveBeenCalled();
    expect(ports.report).not.toHaveBeenCalled();
    expect(ports.advanceOffFailure).not.toHaveBeenCalled();
  });
});
