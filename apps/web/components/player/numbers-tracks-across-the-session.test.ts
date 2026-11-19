// @vitest-environment jsdom

// The "Track X/Y" readout numbers Tracks across the whole Session. The queue
// read only carries the last ~30 played slots, so the Tracks it elided count
// ahead of the ones it returned.
import { createElement, Fragment } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayableTrack } from './playable-track';
import type { PlaybackControllerApi } from './playback-controller-api';
import { usePlaybackController } from './use-playback-controller';
import type { SessionQueueSnapshot } from './use-session-queue';

const reportPlayback = vi.fn();
const sendFeedback = vi.fn();

vi.mock('@/lib/http/api-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    reportPlayback: (body: unknown) => reportPlayback(body),
    sendFeedback: (body: unknown) => {
      sendFeedback(body);
      return Promise.resolve({ ok: true, data: {} });
    },
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

function script(el: HTMLAudioElement): { plays: number } {
  let paused = true;
  const deck = { plays: 0 };
  Object.defineProperty(el, 'currentTime', { value: 0, writable: true, configurable: true });
  Object.defineProperty(el, 'duration', { get: () => 30, configurable: true });
  Object.defineProperty(el, 'readyState', { value: 0, configurable: true });
  Object.defineProperty(el, 'paused', { get: () => paused, configurable: true });
  Object.defineProperty(el, 'error', { get: () => null, configurable: true });
  el.play = () => {
    deck.plays += 1;
    paused = false;
    return Promise.resolve();
  };
  el.pause = () => {
    paused = true;
  };
  el.load = () => undefined;
  return deck;
}

function track(id: string): PlayableTrack {
  return {
    queueState: 'queued',
    vibeSwitchSetAside: false,
    queueItemId: `q-${id}`,
    trackId: id,
    title: id,
    artist: null,
    originSessionTitle: null,
    durationSeconds: 30,
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

function snapshot(tracks: PlayableTrack[], earlierTracks = 0): SessionQueueSnapshot {
  return {
    kind: 'session',
    tracks,
    items: [],
    earlierTracks,
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
  } as SessionQueueSnapshot;
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

async function mountPlaying(tracks: PlayableTrack[], earlierTracks = 0) {
  const view = render(createElement(Probe));
  const decks = {
    a: script(view.getByTestId('deck-a') as HTMLAudioElement),
    b: script(view.getByTestId('deck-b') as HTMLAudioElement),
  };
  await act(async () => {});
  await act(async () => {
    feed!(snapshot(tracks, earlierTracks));
  });
  await act(async () => {
    api.play();
  });
  return decks;
}

afterEach(() => {
  cleanup();
  feed = null;
});

describe('Track numbering (Session source)', () => {
  it('counts the Tracks the queue read elided ahead of the ones it returned', async () => {
    await mountPlaying([track('t1'), track('t2'), track('t3')], 40);

    expect(api.currentTrackNumber).toBe(41);
    expect(api.trackCount).toBe(43);
  });

  it('numbers from one when nothing was elided', async () => {
    await mountPlaying([track('t1'), track('t2')]);

    expect(api.currentTrackNumber).toBe(1);
    expect(api.trackCount).toBe(2);
  });
});
