// @vitest-environment jsdom

// Resume continues where the listener left off. When the Track the Session
// stopped on is gone (disliked or deleted since), the queue read still reports
// its slot position: playback starts at the next remaining Track after it, and
// at the Session's start when nothing is left after it, never back in the
// window's oldest Track.
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
    dislikeTrack: vi.fn(async () => ({ ok: true, data: {} })),
    reportListening: vi.fn(async () => ({ ok: true, data: {} })),
    applyLoopLease: vi.fn(async () => ({ ok: true, data: { held: false } })),
    getPlaybackSettings: vi.fn(async () => ({
      ok: true,
      data: { blendEnabled: false, crossfadeSeconds: 6 },
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
    queuePosition: n - 1,
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

/** A 60-Track Session whose stored current slot (Track `stored`, position
 * `stored - 1`) a Dislike removed: the read anchors on that position, holds the
 * 30 slots before it plus everything after, and Track 1 rides as loop head. */
function windowedSixtyWithout(stored: number): SessionQueueSnapshot {
  const first = stored - 30;
  return snapshot(
    range(first, 60).filter((t) => t.trackId !== `t${stored}`),
    {
      earlierTracks: first - 1,
      loopHead: track(1),
      currentQueueItemId: `q-t${stored}`,
      currentTrackId: `t${stored}`,
      anchorPosition: stored - 1,
    },
  );
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

/** Engage the Session with its first queue load, as a Resume or a reload does. */
async function engage(first: SessionQueueSnapshot) {
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  const view = render(createElement(Probe));
  const deckA = script(view.getByTestId('deck-a') as HTMLAudioElement);
  script(view.getByTestId('deck-b') as HTMLAudioElement);
  await act(async () => {});
  await act(async () => {
    feed!(first);
  });
  await act(async () => {
    api.play();
  });
  await act(async () => {
    deckA.ready();
  });
}

const startedReports = () =>
  reportPlayback.mock.calls
    .map(([body]) => body as { type: string; trackId: string })
    .filter((body) => body.type === 'started');

afterEach(() => {
  cleanup();
  reportPlayback.mockClear();
  feed = null;
});

describe('Resume when the stored Track is gone', () => {
  it('starts on the next remaining Track after the stored place, not the oldest Track of the window', async () => {
    await engage(windowedSixtyWithout(45));
    expect(api.currentTrack?.trackId).toBe('t46');
    expect(startedReports().at(-1)).toMatchObject({ trackId: 't46' });
  });

  it("starts on the Session's first Track when nothing is left after the stored place", async () => {
    await engage(windowedSixtyWithout(60));
    expect(api.currentTrack?.trackId).toBe('t1');
    expect(startedReports().at(-1)).toMatchObject({ trackId: 't1' });
  });

  it("starts on the Session's first Track in a short Session whose read leaves nothing out", async () => {
    await engage(
      snapshot(range(1, 4), {
        currentQueueItemId: 'q-t5',
        currentTrackId: 't5',
        anchorPosition: 4,
      }),
    );
    expect(api.currentTrack?.trackId).toBe('t1');
  });

  it('starts on the stored Track while it still exists', async () => {
    await engage(
      snapshot(range(15, 60), {
        earlierTracks: 14,
        loopHead: track(1),
        currentQueueItemId: 'q-t45',
        currentTrackId: 't45',
        anchorPosition: 44,
      }),
    );
    expect(api.currentTrack?.trackId).toBe('t45');
  });
});
