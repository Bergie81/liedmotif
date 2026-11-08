// @vitest-environment jsdom

// Delete Track is not feedback: once the delete has
// landed, the Session player moves past the audible Track the way a removal
// does — no `skip` feedback event and no `skipped` playback report.
import { createElement, Fragment } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayableTrack } from './playable-track';
import type { PlaybackControllerApi } from './playback-controller-api';
import { usePlaybackController } from './use-playback-controller';
import type { SessionQueueSnapshot } from './use-session-queue';

const reportPlayback = vi.fn();
const sendFeedback = vi.fn();

vi.mock('@/lib/api-client', async (importOriginal) => {
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
let isLocallyRemoved: ((queueItemId: string) => boolean) | null = null;
vi.mock('./use-session-queue', () => ({
  useSessionQueue: (
    sessionId: string | null,
    removed: (queueItemId: string) => boolean,
    onSnapshot: (snapshot: SessionQueueSnapshot) => void,
  ) => {
    if (sessionId) {
      feed = onSnapshot;
      isLocallyRemoved = removed;
    }
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

function snapshot(tracks: PlayableTrack[]): SessionQueueSnapshot {
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

async function mountPlaying(tracks: PlayableTrack[]) {
  const view = render(createElement(Probe));
  const decks = {
    a: script(view.getByTestId('deck-a') as HTMLAudioElement),
    b: script(view.getByTestId('deck-b') as HTMLAudioElement),
  };
  await act(async () => {});
  await act(async () => {
    feed!(snapshot(tracks));
  });
  await act(async () => {
    api.play();
  });
  return decks;
}

const reportsOfType = (type: string) =>
  reportPlayback.mock.calls.filter(([body]) => (body as { type: string }).type === type);

afterEach(() => {
  cleanup();
  reportPlayback.mockClear();
  sendFeedback.mockClear();
  feed = null;
  isLocallyRemoved = null;
});

describe('advancing past a deleted Track (Session source)', () => {
  it('plays the next Track without a skip event or skipped report', async () => {
    const t1 = track('t1');
    const t2 = track('t2');
    const decks = await mountPlaying([t1, t2]);
    expect(api.currentTrack?.trackId).toBe('t1');

    await act(async () => {
      api.advancePastDeletedTrack('t1');
    });

    expect(api.currentTrack?.trackId).toBe('t2');
    expect(decks.b.plays).toBe(1);
    expect(sendFeedback).not.toHaveBeenCalled();
    expect(reportsOfType('skipped')).toHaveLength(0);
    expect(api.queueLength).toBe(1);
    // A stale poll that still lists the deleted Track must not bring it back.
    expect(isLocallyRemoved!(t1.queueItemId)).toBe(true);
  });

  it('leaves playback alone when the deleted Track is no longer the audible one', async () => {
    const decks = await mountPlaying([track('t1'), track('t2')]);

    await act(async () => {
      api.advancePastDeletedTrack('t2');
    });

    expect(api.currentTrack?.trackId).toBe('t1');
    expect(decks.b.plays).toBe(0);
  });
});
