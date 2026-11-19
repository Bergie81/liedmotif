// @vitest-environment jsdom

// Ordered Repeat loops the whole Session. The queue read carries only the last
// 30 slots behind the current Track, so for a long Session it also carries the
// loop head, the Session's first playable Track: after the last Track comes
// Track 1, not the first Track of the window.
import { createElement, Fragment } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BlendEdgeEventDetail, PlayableTrack } from './playable-track';
import type { PlaybackControllerApi } from './playback-controller-api';
import { usePlaybackController } from './use-playback-controller';
import type { SessionQueueSnapshot } from './use-session-queue';

const reportPlayback = vi.fn();
const settings = vi.hoisted(() => ({ blendEnabled: false }));

vi.mock('@/lib/http/api-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    reportPlayback: (body: unknown) => reportPlayback(body),
    sendFeedback: vi.fn(async () => ({ ok: true, data: {} })),
    dislikeTrack: vi.fn(async () => ({ ok: true, data: {} })),
    reportListening: vi.fn(async () => ({ ok: true, data: {} })),
    applyLoopLease: vi.fn(async () => ({ ok: true, data: { held: false } })),
    getPlaybackSettings: vi.fn(async () => ({
      ok: true,
      data: { blendEnabled: settings.blendEnabled, crossfadeSeconds: 6 },
    })),
    updatePlaybackSettings: vi.fn(async () => ({ ok: true, data: {} })),
  };
});

let feed: ((snapshot: SessionQueueSnapshot) => void) | null = null;
vi.mock('./use-session-queue', () => ({
  useSessionQueue: (
    sessionId: string | null,
    _removed: unknown,
    onSnapshot: (snapshot: SessionQueueSnapshot) => void,
  ) => {
    if (sessionId) feed = onSnapshot;
    return () => undefined;
  },
}));

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

const TRACK_SECONDS = 30;

interface ScriptedDeck {
  ready(): void;
  tick(seconds: number): void;
  end(): void;
  fail(): void;
}

function script(el: HTMLAudioElement): ScriptedDeck {
  let currentTime = 0;
  let readyState = 0;
  let paused = true;
  let error: unknown = null;
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
  Object.defineProperty(el, 'error', { get: () => error, configurable: true });
  el.play = () => {
    paused = false;
    return Promise.resolve();
  };
  el.pause = () => {
    paused = true;
  };
  el.load = () => {
    readyState = 0;
    currentTime = 0;
    error = null;
  };
  return {
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
    fail() {
      error = { code: 4 };
      el.dispatchEvent(new Event('error'));
    },
  };
}

// --- fixtures ----------------------------------------------------------------

function track(n: number): PlayableTrack {
  const id = `t${n}`;
  return {
    queueState: 'queued',
    vibeSwitchSetAside: false,
    queueItemId: `q-${id}`,
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

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => track(from + index));

function snapshot(
  tracks: PlayableTrack[],
  extra: Partial<SessionQueueSnapshot> = {},
): SessionQueueSnapshot {
  return {
    kind: 'session',
    tracks,
    items: [],
    earlierTracks: 0,
    queueItemIds: new Set(tracks.map((t) => t.queueItemId)),
    currentQueueItemId: null,
    currentTrackId: null,
    generationStatus: 'ok',
    generationStatusScope: null,
    statusMessageSafe: null,
    sessionStatus: 'active',
    coverImageId: null,
    styleRevision: 1,
    generatingTracksAhead: 0,
    generatingNewVibeTracksAhead: 0,
    pendingGeneration: null,
    vibe: null,
    switchPending: false,
    tryAgainTracks: null,
    ...extra,
  };
}

/** A 60-Track Session read while Track `current` plays: the window holds the
 * 30 Tracks before it plus everything from it on; Track 1 rides as loop head. */
function windowedSixty(current: number): SessionQueueSnapshot {
  const first = current - 30;
  return snapshot(range(first, 60), {
    earlierTracks: first - 1,
    loopHead: track(1),
    currentQueueItemId: `q-t${current}`,
    currentTrackId: `t${current}`,
  });
}

/** The read once the server has seen Track 1 start: anchored there, it is whole. */
const wholeSixty = () =>
  snapshot(range(1, 60), { currentQueueItemId: 'q-t1', currentTrackId: 't1' });

let api: PlaybackControllerApi;
function Probe() {
  api = usePlaybackController({ kind: 'session', sessionId: 's1' }, { mediaSessionEnabled: false });
  return createElement(
    Fragment,
    null,
    createElement('audio', { 'data-testid': 'deck-a', ref: api.deckARef }),
    createElement('audio', { 'data-testid': 'deck-b', ref: api.deckBRef }),
  );
}

async function mountPlaying(first: SessionQueueSnapshot) {
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  const view = render(createElement(Probe));
  const decks = {
    a: script(view.getByTestId('deck-a') as HTMLAudioElement),
    b: script(view.getByTestId('deck-b') as HTMLAudioElement),
  };
  await act(async () => {});
  await act(async () => {
    feed!(first);
  });
  await act(async () => {
    api.play();
  });
  await act(async () => {
    decks.a.ready();
  });
  return decks;
}

const startedReports = () =>
  reportPlayback.mock.calls
    .map(([body]) => body as { type: string; trackId: string; queueWrapped?: boolean })
    .filter((body) => body.type === 'started');

afterEach(() => {
  cleanup();
  reportPlayback.mockClear();
  settings.blendEnabled = false;
  feed = null;
});

describe('ordered Repeat over a Session longer than the queue window', () => {
  it("wraps from the last Track to the Session's first Track, not the window's first", async () => {
    const decks = await mountPlaying(windowedSixty(60));
    expect(api.currentTrack?.trackId).toBe('t60');
    expect([api.currentTrackNumber, api.trackCount]).toEqual([60, 60]);

    await act(async () => {
      decks.a.end();
    });

    expect(api.currentTrack?.trackId).toBe('t1');
    expect(startedReports().at(-1)).toMatchObject({ trackId: 't1', queueWrapped: true });
    expect([api.currentTrackNumber, api.trackCount]).toEqual([1, 60]);
  });

  it('keeps the loop head playing through a read the server answered before its start, then plays on in Session order', async () => {
    const decks = await mountPlaying(windowedSixty(60));
    await act(async () => {
      decks.a.end();
    });
    expect(api.currentTrack?.trackId).toBe('t1');

    // The server has not seen Track 1 start yet: the read is still the old window.
    await act(async () => {
      feed!(windowedSixty(60));
    });
    expect(api.currentTrack?.trackId).toBe('t1');
    expect([api.currentTrackNumber, api.trackCount]).toEqual([1, 60]);

    await act(async () => {
      feed!(wholeSixty());
    });
    expect([api.currentTrackNumber, api.trackCount]).toEqual([1, 60]);
    await act(async () => {
      decks.b.end();
    });
    expect(api.currentTrack?.trackId).toBe('t2');
    expect(startedReports().at(-1)).toMatchObject({ trackId: 't2' });
    expect(startedReports().at(-1)?.queueWrapped).toBeUndefined();
  });

  it('Skip on the last Track goes to the first Track of the Session', async () => {
    await mountPlaying(windowedSixty(60));
    await act(async () => {
      api.skip();
    });
    expect(api.currentTrack?.trackId).toBe('t1');
    expect(startedReports().at(-1)).toMatchObject({ trackId: 't1', queueWrapped: true });
  });

  it('a Dislike of the last Track moves on to the first Track of the Session', async () => {
    await mountPlaying(windowedSixty(60));
    await act(async () => {
      api.dislike();
    });
    expect(api.currentTrack?.trackId).toBe('t1');
    expect([api.currentTrackNumber, api.trackCount]).toEqual([1, 59]);
  });

  it('a Delete Track of the last Track moves on to the first Track of the Session', async () => {
    await mountPlaying(windowedSixty(60));
    await act(async () => {
      api.advancePastDeletedTrack('t60');
    });
    expect(api.currentTrack?.trackId).toBe('t1');
  });

  it('failed audio on the last Track moves on to the first Track of the Session', async () => {
    const decks = await mountPlaying(windowedSixty(60));
    await act(async () => {
      decks.a.fail();
    });
    expect(api.currentTrack?.trackId).toBe('t1');
  });

  it('prepares the loop head before the last Track ends and blends into it, through a poll in between', async () => {
    settings.blendEnabled = true;
    const edges: BlendEdgeEventDetail[] = [];
    const onEdge = (event: Event) =>
      edges.push((event as CustomEvent<BlendEdgeEventDetail>).detail);
    window.addEventListener('liedmotif:blend-edge', onEdge);
    try {
      const decks = await mountPlaying(windowedSixty(60));
      expect(api.currentTrack?.trackId).toBe('t60');

      // Fade start = 30 − 6 = 24 s; preparation begins 8 s earlier.
      await act(async () => {
        decks.a.tick(17);
      });
      await act(async () => {
        feed!(windowedSixty(60));
      });
      await act(async () => {
        decks.b.ready();
      });
      await act(async () => {
        decks.a.tick(24.2);
      });

      expect(api.currentTrack?.trackId).toBe('t1');
      expect(edges.filter((edge) => edge.committed).map((edge) => edge.trackId)).toEqual(['t1']);
      expect(startedReports().at(-1)).toMatchObject({ trackId: 't1', queueWrapped: true });
    } finally {
      window.removeEventListener('liedmotif:blend-edge', onEdge);
    }
  });

  it('Back on the first Track of the window restarts it rather than jumping to the loop head', async () => {
    await mountPlaying(windowedSixty(60));
    await act(async () => {
      api.playQueueItem('q-t30');
    });
    expect([api.currentTrackNumber, api.trackCount]).toEqual([30, 60]);
    await act(async () => {
      api.back();
    });
    expect(api.currentTrack?.trackId).toBe('t30');
  });

  it('wraps to the first Track as before when the read left nothing out', async () => {
    const decks = await mountPlaying(
      snapshot(range(1, 3), { currentQueueItemId: 'q-t3', currentTrackId: 't3' }),
    );
    expect(api.currentTrack?.trackId).toBe('t3');
    await act(async () => {
      decks.a.end();
    });
    expect(api.currentTrack?.trackId).toBe('t1');
    expect([api.currentTrackNumber, api.trackCount]).toEqual([1, 3]);
  });
});
