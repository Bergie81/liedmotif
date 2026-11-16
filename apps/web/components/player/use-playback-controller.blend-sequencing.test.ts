// @vitest-environment jsdom

// Live blend SEQUENCING through the real controller: the full deck-lifecycle +
// prepared-deck driver glue over scripted media elements and a fake Web Audio
// graph. A Playlist source feeds the queue (one static snapshot, no polling),
// so consecutive edges, the tail lifecycle, and Back are exercised exactly as
// the session player runs them — only the DSP and the network are fake.

import { createElement, Fragment } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BlendEdgeEventDetail, PlayableTrack } from './playable-track';
import type { PlaybackControllerApi, PlayerControllerSource } from './playback-controller-api';
import { usePlaybackController } from './use-playback-controller';

// --- fake Web Audio (enough surface for PlayerEngine.attach + crossfade) ----

function fakeParam() {
  return {
    value: 1,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
    cancelAndHoldAtTime: vi.fn(),
  };
}

function fakeNode(): Record<string, unknown> {
  return {
    connect: (next: unknown) => next,
    disconnect: () => undefined,
    gain: fakeParam(),
    frequency: fakeParam(),
    Q: fakeParam(),
    detune: fakeParam(),
    threshold: fakeParam(),
    knee: fakeParam(),
    ratio: fakeParam(),
    attack: fakeParam(),
    release: fakeParam(),
    type: 'lowshelf',
  };
}

class FakeAudioContext {
  currentTime = 100;
  state = 'running';
  destination = fakeNode();
  createGain = () => fakeNode();
  createBiquadFilter = () => fakeNode();
  createDynamicsCompressor = () => fakeNode();
  createMediaElementSource = () => fakeNode();
  resume = () => Promise.resolve();
  close = () => Promise.resolve();
  addEventListener = () => undefined;
  removeEventListener = () => undefined;
}

// --- scripted media elements ------------------------------------------------

interface ScriptedDeck {
  el: HTMLAudioElement;
  /** Mark the loaded source ready (readyState 4) and fire `canplay`. */
  ready(): void;
  /** Move the clock and fire `timeupdate`. */
  tick(seconds: number): void;
  /** Play the element out: clock to duration, `ended`, paused. */
  end(): void;
  readonly playing: boolean;
  /** Reload count — releasing a prepared deck unloads its element. */
  readonly loads: number;
}

const TRACK_SECONDS = 30;

function script(el: HTMLAudioElement): ScriptedDeck {
  let currentTime = 0;
  let readyState = 0;
  let paused = true;
  let loads = 0;
  Object.defineProperty(el, 'currentTime', {
    get: () => currentTime,
    set: (v: number) => {
      currentTime = v;
    },
    configurable: true,
  });
  Object.defineProperty(el, 'duration', { get: () => TRACK_SECONDS, configurable: true });
  Object.defineProperty(el, 'readyState', { get: () => readyState, configurable: true });
  Object.defineProperty(el, 'paused', { get: () => paused, configurable: true });
  Object.defineProperty(el, 'error', { value: null, writable: true, configurable: true });
  el.play = () => {
    paused = false;
    return Promise.resolve();
  };
  el.pause = () => {
    paused = true;
  };
  el.load = () => {
    loads += 1;
    readyState = 0;
    currentTime = 0;
  };
  return {
    el,
    ready() {
      readyState = 4;
      el.dispatchEvent(new Event('canplay'));
    },
    tick(seconds: number) {
      currentTime = seconds;
      el.dispatchEvent(new Event('timeupdate'));
    },
    end() {
      currentTime = TRACK_SECONDS;
      paused = true;
      el.dispatchEvent(new Event('ended'));
    },
    get playing() {
      return !paused;
    },
    get loads() {
      return loads;
    },
  };
}

// --- fixtures ----------------------------------------------------------------

function track(id: string): PlayableTrack {
  return {
    queueState: 'queued',
    vibeSwitchSetAside: false,
    queueItemId: id,
    trackId: id,
    title: id,
    artist: null,
    originSessionTitle: null,
    durationSeconds: TRACK_SECONDS,
    coverImageId: null,
    genreTags: [],
    vocalMode: 'instrumental',
    hasLyrics: false,
    downloadable: true,
    savedAt: null,
    favoritedAt: null,
    inCuratedPlaylist: false,
    assets: { final: `/api/audio/${id}?asset=final`, stream: null },
    styleRevision: 1,
    targetBpm: null,
    targetKey: null,
    blendAnalysis: null,
  };
}

let api: PlaybackControllerApi;

function Probe({ source }: { source: PlayerControllerSource }) {
  api = usePlaybackController(source, { mediaSessionEnabled: false });
  return createElement(
    Fragment,
    null,
    createElement('audio', { 'data-testid': 'deck-a', ref: api.deckARef }),
    createElement('audio', { 'data-testid': 'deck-b', ref: api.deckBRef }),
  );
}

interface Harness {
  decks: Record<'a' | 'b', ScriptedDeck>;
  edges: BlendEdgeEventDetail[];
  api(): PlaybackControllerApi;
  /** Store `patch` past the player, as the Assistant does. */
  storeSettings(patch: Partial<{ blendEnabled: boolean; crossfadeSeconds: number }>): void;
}

async function mount(
  trackIds: string[],
  options: { failSettingsWrite?: boolean } = {},
): Promise<Harness> {
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  // The settings endpoint holds real state: a POST that lands changes what the
  // next read answers, so a toggle is not silently undone by the stub.
  let settings = { blendEnabled: true, crossfadeSeconds: 6 };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (!String(url).includes('/api/settings/playback')) {
        return Promise.resolve({ json: async () => ({ ok: true, data: {} }) });
      }
      if (init?.method === 'POST') {
        if (options.failSettingsWrite) {
          return Promise.resolve({
            json: async () => ({
              ok: false,
              error: { code: 'internal_error', message: 'Settings write failed.', retryable: true },
            }),
          });
        }
        const patch = typeof init.body === 'string' ? JSON.parse(init.body) : {};
        settings = { ...settings, ...patch };
      }
      return Promise.resolve({ json: async () => ({ ok: true, data: settings }) });
    }),
  );
  const edges: BlendEdgeEventDetail[] = [];
  window.addEventListener('liedmotif:blend-edge', (event) => {
    edges.push((event as CustomEvent<BlendEdgeEventDetail>).detail);
  });
  const source: PlayerControllerSource = {
    kind: 'playlist',
    playlistId: 'pl-1',
    tracks: trackIds.map(track),
    startTrackId: trackIds[0] ?? null,
  };
  const view = render(createElement(Probe, { source }));
  const decks = {
    a: script(view.getByTestId('deck-a') as HTMLAudioElement),
    b: script(view.getByTestId('deck-b') as HTMLAudioElement),
  };
  // Settle the playback-settings fetch (the blend gate waits on it).
  await act(async () => {});
  return {
    decks,
    edges,
    api: () => api,
    storeSettings: (patch) => {
      settings = { ...settings, ...patch };
    },
  };
}

/** Drive one full blend edge off the audible `out` deck: preparation trigger,
 * incoming readiness, then the fade-start threshold. Returns after the plain
 * edge's play-resolve microtask, i.e. after the commit (when the blend works). */
async function driveEdge(h: Harness, out: 'a' | 'b'): Promise<void> {
  const incoming = out === 'a' ? 'b' : 'a';
  // Fade start = 30 − 6 = 24 s; preparation lead begins 8 s earlier (16 s).
  await act(async () => {
    h.decks[out].tick(17);
  });
  await act(async () => {
    h.decks[incoming].ready();
  });
  await act(async () => {
    h.decks[out].tick(24.2);
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('live blend sequencing (real controller, scripted decks)', () => {
  it('blends EVERY consecutive edge, not just the first', async () => {
    const h = await mount(['t1', 't2', 't3', 't4']);
    await act(async () => {
      h.api().play();
    });
    await act(async () => {
      h.decks.a.ready();
    });
    expect(h.api().currentTrack?.trackId).toBe('t1');

    // Edge 1→2 (out: deck A).
    await driveEdge(h, 'a');
    expect(h.api().currentTrack?.trackId).toBe('t2');
    // Track 1's tail plays out on deck A and releases the slot.
    await act(async () => {
      h.decks.a.end();
    });

    // Edge 2→3 leaves from deck B: the decks alternate, so a blend that only
    // ever arms on deck A would pass the first edge and fail here.
    await driveEdge(h, 'b');
    expect(h.api().currentTrack?.trackId).toBe('t3');
    await act(async () => {
      h.decks.b.end();
    });

    // Edge 3→4 (out: deck A again).
    await driveEdge(h, 'a');
    expect(h.api().currentTrack?.trackId).toBe('t4');

    // Every edge COMMITTED as a blend (no silent hard-cut fallbacks).
    const committed = h.edges.filter((edge) => edge.committed).map((edge) => edge.trackId);
    expect(committed).toEqual(['t2', 't3', 't4']);
  });

  it('blends into the next track again after Back returns to the previous one', async () => {
    const h = await mount(['t1', 't2', 't3']);
    await act(async () => {
      h.api().play();
    });
    await act(async () => {
      h.decks.a.ready();
    });

    // Edge 1→2 commits; deck A still carries track 1's fading tail.
    await driveEdge(h, 'a');
    expect(h.api().currentTrack?.trackId).toBe('t2');

    // Back within the restart window steps to track 1 (a hard cut).
    await act(async () => {
      h.decks.b.tick(1);
      h.api().back();
    });
    await act(async () => {
      h.decks.a.ready();
    });
    expect(h.api().currentTrack?.trackId).toBe('t1');

    // The 1→2 edge must blend AGAIN.
    await driveEdge(h, 'a');
    expect(h.api().currentTrack?.trackId).toBe('t2');
    const committed = h.edges.filter((edge) => edge.committed).map((edge) => edge.trackId);
    expect(committed).toEqual(['t2', 't2']);
  });

  it('strikes the armed edge when blends are switched off mid-track', async () => {
    const h = await mount(['t1', 't2']);
    await act(async () => {
      h.api().play();
    });
    await act(async () => {
      h.decks.a.ready();
    });

    // Arm the edge: the incoming deck is prepared and ready, which is where the
    // aligned automation is scheduled — long before the fade would be audible.
    await act(async () => {
      h.decks.a.tick(17);
    });
    await act(async () => {
      h.decks.b.ready();
    });

    const preparedLoads = h.decks.b.loads;
    await act(async () => {
      h.api().toggleBlend();
    });
    expect(h.api().blendEnabled).toBe(false);
    // Striking the edge RELEASES its prepared deck. Without that, the armed
    // automation survives the toggle and the next transition still crossfades.
    expect(h.decks.b.loads).toBeGreaterThan(preparedLoads);

    // Past the fade-start threshold: nothing crossfades and nothing advances.
    await act(async () => {
      h.decks.a.tick(24.2);
    });
    expect(h.api().currentTrack?.trackId).toBe('t1');
    expect(h.edges.filter((edge) => edge.committed)).toEqual([]);

    // The advance lands on `ended` instead — the strictly sequential path.
    await act(async () => {
      h.decks.a.end();
    });
    expect(h.api().currentTrack?.trackId).toBe('t2');
  });

  it('strikes the armed edge when blends were switched off past the player, writing nothing', async () => {
    const h = await mount(['t1', 't2']);
    await act(async () => {
      h.api().play();
    });
    await act(async () => {
      h.decks.a.ready();
    });
    await act(async () => {
      h.decks.a.tick(17);
    });
    await act(async () => {
      h.decks.b.ready();
    });

    h.storeSettings({ blendEnabled: false });
    const fetches = vi.mocked(fetch).mock.calls.length;
    const preparedLoads = h.decks.b.loads;
    await act(async () => {
      h.api().adoptStoredPlaybackSettings();
    });
    expect(h.api().blendEnabled).toBe(false);
    expect(h.decks.b.loads).toBeGreaterThan(preparedLoads);
    const sent = vi.mocked(fetch).mock.calls.slice(fetches);
    expect(sent.map(([url, init]) => [String(url), init?.method ?? 'GET'])).toEqual([
      ['/api/settings/playback', 'GET'],
    ]);

    await act(async () => {
      h.decks.a.tick(24.2);
    });
    expect(h.api().currentTrack?.trackId).toBe('t1');
    expect(h.edges.filter((edge) => edge.committed)).toEqual([]);
    await act(async () => {
      h.decks.a.end();
    });
    expect(h.api().currentTrack?.trackId).toBe('t2');
  });

  it('keeps blending when the toggle-off write fails and the gate reverts', async () => {
    const h = await mount(['t1', 't2'], { failSettingsWrite: true });
    await act(async () => {
      h.api().play();
    });
    await act(async () => {
      h.decks.a.ready();
    });
    await act(async () => {
      h.decks.a.tick(17);
    });
    await act(async () => {
      h.decks.b.ready();
    });

    await act(async () => {
      h.api().toggleBlend();
    });
    // The write did not land, so the gate goes back on and the player says so.
    expect(h.api().blendEnabled).toBe(true);
    expect(h.api().actionError).toContain('Settings write failed.');

    // Preparation re-arms off the next timeupdate, so the edge still blends —
    // the cancel must not have poisoned the transition for good.
    await act(async () => {
      h.decks.a.tick(17.5);
    });
    await act(async () => {
      h.decks.b.ready();
    });
    await act(async () => {
      h.decks.a.tick(24.2);
    });
    expect(h.api().currentTrack?.trackId).toBe('t2');
    expect(h.edges.filter((edge) => edge.committed).map((edge) => edge.trackId)).toEqual(['t2']);
  });
});

// The cover swipe previews the Track it would land on, so the preview must be
// exactly what Skip and Previous then play — including in shuffle, where the
// next pick is random.
describe('swipe neighbors (real controller, scripted decks)', () => {
  async function settle(h: Harness) {
    await act(async () => {
      h.decks.a.ready();
      h.decks.b.ready();
    });
  }

  it('previews the ordered neighbors and steps back even mid-track', async () => {
    const h = await mount(['t1', 't2', 't3']);
    await act(async () => {
      h.api().play();
    });
    await settle(h);
    await act(async () => {
      h.api().skip();
    });
    await settle(h);
    expect(h.api().currentTrack?.trackId).toBe('t2');

    const neighbors = h.api().peekNeighbors();
    expect(neighbors.next?.trackId).toBe('t3');
    expect(neighbors.previous?.trackId).toBe('t1');

    // Past Back's restart window: Previous still lands on the previewed Track.
    await act(async () => {
      h.decks.b.tick(20);
      h.api().previous();
    });
    await settle(h);
    expect(h.api().currentTrack?.trackId).toBe('t1');
  });

  it('previews the shuffle pick that Skip then plays, and the Track Previous returns to', async () => {
    const h = await mount(['t1', 't2', 't3', 't4', 't5', 't6']);
    await act(async () => {
      h.api().play();
    });
    await settle(h);
    await act(async () => {
      h.api().cyclePlaybackMode();
    });
    await act(async () => {
      h.api().cyclePlaybackMode();
    });
    expect(h.api().playbackMode).toBe('shuffle');

    const played = [h.api().currentTrack?.trackId];
    for (let step = 0; step < 4; step += 1) {
      const next = h.api().peekNeighbors().next?.trackId;
      await act(async () => {
        h.api().skip();
      });
      await settle(h);
      expect(h.api().currentTrack?.trackId).toBe(next);
      played.push(next);
    }

    const previous = h.api().peekNeighbors().previous?.trackId;
    expect(previous).toBe(played.at(-2));
    await act(async () => {
      h.api().previous();
    });
    await settle(h);
    expect(h.api().currentTrack?.trackId).toBe(previous);
  });
});
