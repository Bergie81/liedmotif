// @vitest-environment jsdom

// Shuffle traverses the whole Session. The windowed queue read holds only the
// last 30 slots behind the current Track, so a long Session under Shuffle
// reads without the window: one pass plays every Track once, and Back walks
// through everything played in this run, however far behind.
import { createElement, Fragment } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayableTrack } from './playable-track';
import type { PlaybackControllerApi } from './playback-controller-api';
import { usePlaybackController } from './use-playback-controller';
import type { SessionQueueSnapshot } from './use-session-queue';

const reportPlayback = vi.fn();

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    reportPlayback: (body: unknown) => reportPlayback(body),
    sendFeedback: vi.fn(async () => ({ ok: true, data: {} })),
    reportListening: vi.fn(async () => ({ ok: true, data: {} })),
    applyLoopLease: vi.fn(async () => ({ ok: true, data: { held: false } })),
    getPlaybackSettings: vi.fn(async () => ({
      ok: true,
      data: { blendEnabled: false, crossfadeSeconds: 6 },
    })),
    updatePlaybackSettings: vi.fn(async () => ({ ok: true, data: {} })),
  };
});

// The queue double: it hands the controller's snapshot sink and the read it
// asked for (full or windowed) to the test, which answers like the server.
let feed: ((snapshot: SessionQueueSnapshot) => void) | null = null;
let askedForFullRead = false;
vi.mock('./use-session-queue', () => ({
  useSessionQueue: (
    sessionId: string | null,
    _removed: unknown,
    onSnapshot: (snapshot: SessionQueueSnapshot) => void,
    _isPlaying: unknown,
    fullRead?: boolean,
  ) => {
    if (sessionId) {
      feed = onSnapshot;
      askedForFullRead = fullRead === true;
    }
    return () => undefined;
  },
}));

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

const TRACK_SECONDS = 30;

function scriptReady(el: HTMLAudioElement): () => void {
  let readyState = 0;
  let paused = true;
  Object.defineProperty(el, 'duration', { get: () => TRACK_SECONDS, configurable: true });
  Object.defineProperty(el, 'readyState', { get: () => readyState, configurable: true });
  Object.defineProperty(el, 'paused', { get: () => paused, configurable: true });
  el.play = () => {
    paused = false;
    return Promise.resolve();
  };
  el.pause = () => {
    paused = true;
  };
  el.load = () => {
    readyState = 0;
  };
  return () => {
    readyState = 4;
    el.dispatchEvent(new Event('canplay'));
  };
}

// --- the Session and the server's reads of it ---------------------------------

const SESSION_TRACKS = 40;
const WINDOW_SLOTS = 30;

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

const startedTrackIds = () =>
  reportPlayback.mock.calls
    .map(([body]) => body as { type: string; trackId: string })
    .filter((body) => body.type === 'started')
    .map((body) => body.trackId);

/** What the server answers: anchored on the last Track it saw start, the
 * window is the 30 slots before it plus everything forward, with Track 1 as
 * loop head; the full read is the whole Session. */
function serverRead(): SessionQueueSnapshot {
  const current = Number((startedTrackIds().at(-1) ?? `t${SESSION_TRACKS}`).slice(1));
  const first = askedForFullRead ? 1 : Math.max(1, current - WINDOW_SLOTS);
  const tracks = range(first, SESSION_TRACKS);
  return {
    kind: 'session',
    tracks,
    items: [],
    earlierTracks: first - 1,
    ...(first > 1 ? { loopHead: track(1) } : {}),
    queueItemIds: new Set(tracks.map((t) => t.queueItemId)),
    currentQueueItemId: `q-t${current}`,
    currentTrackId: `t${current}`,
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
  };
}

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

/** Playing the Session's last Track, from a windowed read. */
async function mountPlayingTheLastTrack() {
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  const view = render(createElement(Probe));
  const ready = scriptReady(view.getByTestId('deck-a') as HTMLAudioElement);
  scriptReady(view.getByTestId('deck-b') as HTMLAudioElement);
  await act(async () => {});
  await act(async () => {
    feed!(serverRead());
  });
  await act(async () => {
    api.play();
  });
  await act(async () => {
    ready();
  });
  expect(api.currentTrack?.trackId).toBe(`t${SESSION_TRACKS}`);
}

/** A poll lands, answered for the read the player asks for right now. */
async function poll() {
  await act(async () => {
    feed!(serverRead());
  });
}

const trackNumberOf = (trackId: string | undefined) => Number(trackId?.slice(1));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  reportPlayback.mockClear();
  feed = null;
  askedForFullRead = false;
});

describe('Shuffle over a Session longer than the queue window', () => {
  it('plays every Track once per pass, and Back walks the whole run back', async () => {
    // A fixed shuffle order keeps the run reproducible.
    let seed = 7;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    });
    await mountPlayingTheLastTrack();
    await act(async () => {
      api.setPlaybackMode('shuffle');
    });
    await poll();

    const played = [api.currentTrack!.trackId];
    for (let step = 1; step < SESSION_TRACKS; step += 1) {
      await act(async () => {
        api.skip();
      });
      played.push(api.currentTrack!.trackId);
      await poll();
      expect(api.currentTrackNumber).toBe(trackNumberOf(api.currentTrack?.trackId));
      expect(api.trackCount).toBe(SESSION_TRACKS);
    }
    expect(new Set(played).size).toBe(SESSION_TRACKS);

    for (let step = SESSION_TRACKS - 2; step >= 0; step -= 1) {
      await act(async () => {
        api.back();
      });
      expect(api.currentTrack?.trackId).toBe(played[step]);
      await poll();
    }
  });
});
