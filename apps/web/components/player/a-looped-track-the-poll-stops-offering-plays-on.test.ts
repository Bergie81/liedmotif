// @vitest-environment jsdom

// Loop Track pins the audible Track. A Queue poll can drop that Track from the
// playable Tracks while its Queue item stays (its source availability is being
// refreshed): the loop holds on to it, so it replays instead of the player
// stopping to wait.
import { createElement, Fragment } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayableTrack } from './playable-track';
import type { PlaybackControllerApi } from './playback-controller-api';
import { usePlaybackController } from './use-playback-controller';
import type { SessionQueueSnapshot } from './use-session-queue';

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    reportPlayback: vi.fn(),
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

let feed: ((snapshot: SessionQueueSnapshot) => void) | null = null;
vi.mock('./use-session-queue', () => ({
  useSessionQueue: (
    sessionId: string | null,
    _removed: (queueItemId: string) => boolean,
    onSnapshot: (snapshot: SessionQueueSnapshot) => void,
  ) => {
    if (sessionId) {
      feed = onSnapshot;
    }
    return () => undefined;
  },
}));

interface ScriptedDeck {
  plays: number;
  src: () => string | null;
  ready(): void;
}

function script(el: HTMLAudioElement): ScriptedDeck {
  let paused = true;
  let readyState = 0;
  const deck: ScriptedDeck = {
    plays: 0,
    src: () => el.getAttribute('src'),
    ready() {
      readyState = 4;
      el.dispatchEvent(new Event('canplay'));
    },
  };
  Object.defineProperty(el, 'currentTime', { value: 0, writable: true, configurable: true });
  Object.defineProperty(el, 'duration', { get: () => 30, configurable: true });
  Object.defineProperty(el, 'readyState', { get: () => readyState, configurable: true });
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
  el.load = () => {
    readyState = 0;
  };
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

/** `tracks` is the playable projection; `queueItemIds` every slot the poll still lists. */
function snapshot(
  tracks: PlayableTrack[],
  queueItemIds = tracks.map((t) => t.queueItemId),
): SessionQueueSnapshot {
  return {
    kind: 'session',
    tracks,
    items: [],
    earlierTracks: 0,
    queueItemIds: new Set(queueItemIds),
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

afterEach(() => {
  cleanup();
  feed = null;
});

describe('a looped Track the Queue poll stops offering', () => {
  it('stays in the projection and replays at its end', async () => {
    const t1 = track('t1');
    const t2 = track('t2');
    const view = render(createElement(Probe));
    const decks = {
      a: script(view.getByTestId('deck-a') as HTMLAudioElement),
      b: script(view.getByTestId('deck-b') as HTMLAudioElement),
    };
    await act(async () => {});
    await act(async () => {
      feed!(snapshot([t1, t2]));
    });
    await act(async () => {
      api.play();
    });
    await act(async () => {
      decks.a.ready();
    });
    await act(async () => {
      api.setPlaybackMode('loop-track');
    });
    expect(api.loopActive).toBe(true);

    // The looped slot is still in the Queue, but no longer playable.
    await act(async () => {
      feed!(snapshot([t2], [t1.queueItemId, t2.queueItemId]));
    });

    expect(api.playableQueueItemIds).toEqual([t1.queueItemId, t2.queueItemId]);
    expect(api.loopActive).toBe(true);

    await act(async () => {
      view.getByTestId('deck-a').dispatchEvent(new Event('ended'));
    });

    expect(api.currentTrack).toBe(t1);
    expect(api.status).not.toBe('waiting');
    expect(decks.b.plays).toBe(1);
    expect(decks.b.src()).toContain('t1');
  });
});
