// @vitest-environment jsdom

// The controller's output level and a committed Rename both reach the decks
// directly. jsdom has no `AudioContext`, so these run on the sequential element
// path, where the output level rides element volume.
import { createElement, Fragment } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueItem } from '@liedmotif/shared';
import type { PlayableTrack } from './playable-track';
import type { PlaybackControllerApi, PlaybackControllerInit } from './playback-controller-api';
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
    if (sessionId) feed = onSnapshot;
    return () => undefined;
  },
}));

interface ScriptedDeck {
  plays: number;
  volumeWrites: number;
  volumeAtPlay: number[];
}

// Keeps whatever volume the mount already wrote, then counts every later write.
function script(el: HTMLAudioElement): ScriptedDeck {
  let paused = true;
  let volume = el.volume;
  const deck: ScriptedDeck = { plays: 0, volumeWrites: 0, volumeAtPlay: [] };
  Object.defineProperty(el, 'currentTime', { value: 0, writable: true, configurable: true });
  Object.defineProperty(el, 'duration', { get: () => 30, configurable: true });
  Object.defineProperty(el, 'readyState', { value: 0, configurable: true });
  Object.defineProperty(el, 'paused', { get: () => paused, configurable: true });
  Object.defineProperty(el, 'error', { get: () => null, configurable: true });
  Object.defineProperty(el, 'volume', {
    get: () => volume,
    set: (next: number) => {
      deck.volumeWrites += 1;
      volume = next;
    },
    configurable: true,
  });
  el.play = () => {
    deck.plays += 1;
    deck.volumeAtPlay.push(volume);
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

function queueItem(id: string, position: number): QueueItem {
  return {
    id: `q-${id}`,
    position,
    state: 'queued',
    vibeSwitchSetAside: false,
    trackId: id,
    track: {
      id,
      title: id,
      generatedArtistName: null,
      status: 'ready',
      durationSeconds: 30,
      coverImageId: null,
      audioUrl: null,
      savedAt: null,
      favoritedAt: null,
      inCuratedPlaylist: false,
      dislikedAt: null,
      genreTags: [],
      vocalMode: 'instrumental',
      hasLyrics: false,
      downloadable: true,
    },
    targetBpm: null,
    targetKey: null,
    styleRevision: 1,
    durationSeconds: 30,
    assets: { final: `/api/audio/${id}?asset=final`, stream: null },
    blendAnalysis: null,
  } as QueueItem;
}

function snapshot(tracks: PlayableTrack[]): SessionQueueSnapshot {
  return {
    kind: 'session',
    tracks,
    items: tracks.map((t, i) => queueItem(t.trackId, i)),
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
  } as SessionQueueSnapshot;
}

let api: PlaybackControllerApi;
function Probe({ init }: { init: PlaybackControllerInit }) {
  api = usePlaybackController({ kind: 'session', sessionId: 's1' }, init);
  return createElement(
    Fragment,
    null,
    createElement('audio', { 'data-testid': 'deck-a', ref: api.deckARef }),
    createElement('audio', { 'data-testid': 'deck-b', ref: api.deckBRef }),
  );
}

async function mount(init: PlaybackControllerInit = {}) {
  const view = render(createElement(Probe, { init: { mediaSessionEnabled: false, ...init } }));
  const decks = {
    a: script(view.getByTestId('deck-a') as HTMLAudioElement),
    b: script(view.getByTestId('deck-b') as HTMLAudioElement),
    elA: view.getByTestId('deck-a') as HTMLAudioElement,
    elB: view.getByTestId('deck-b') as HTMLAudioElement,
  };
  await act(async () => {});
  return decks;
}

async function feedAndPlay(tracks: PlayableTrack[]) {
  await act(async () => {
    feed!(snapshot(tracks));
  });
  await act(async () => {
    api.play();
  });
}

const sheetTitle = (trackId: string) =>
  api.queueItems.find((item) => item.trackId === trackId)?.track?.title;

afterEach(() => {
  cleanup();
  feed = null;
});

describe('the output level on the element path', () => {
  it('sets both deck elements before any graph exists', async () => {
    const decks = await mount();

    await act(async () => {
      api.setOutputVolume(0.4);
    });

    expect(decks.elA.volume).toBe(0.4);
    expect(decks.elB.volume).toBe(0.4);
  });

  it('clamps a level outside 0–1', async () => {
    const decks = await mount();

    await act(async () => {
      api.setOutputVolume(1.7);
    });
    // The mount already holds 1, so the clamped value writes nothing.
    expect(decks.a.volumeWrites).toBe(0);
    expect(decks.elA.volume).toBe(1);

    await act(async () => {
      api.setOutputVolume(-0.3);
    });
    expect(decks.elA.volume).toBe(0);
    expect(decks.elB.volume).toBe(0);
  });

  it('writes nothing when the same level is set again', async () => {
    const decks = await mount();
    await act(async () => {
      api.setOutputVolume(0.4);
    });
    const writes = { a: decks.a.volumeWrites, b: decks.b.volumeWrites };

    await act(async () => {
      api.setOutputVolume(0.4);
    });

    expect(decks.a.volumeWrites).toBe(writes.a);
    expect(decks.b.volumeWrites).toBe(writes.b);
  });

  it('mounts muted with both elements at 0 and starts the first Track silent', async () => {
    const decks = await mount({ initialOutputVolume: 0 });

    expect(decks.elA.volume).toBe(0);
    expect(decks.elB.volume).toBe(0);
    expect(decks.a.plays).toBe(0);

    await feedAndPlay([track('t1'), track('t2')]);

    expect(api.currentTrack?.trackId).toBe('t1');
    expect(decks.a.plays).toBe(1);
    expect(decks.a.volumeAtPlay).toEqual([0]);
    expect(decks.elA.volume).toBe(0);
    expect(decks.elB.volume).toBe(0);
  });
});

describe('a committed Rename', () => {
  it('reaches the audible Track, its Queue sheet item and the held deck Track at once', async () => {
    await mount();
    const held = track('t1');
    await feedAndPlay([held, track('t2')]);
    // A later poll brings fresh objects: the projection takes them, while the
    // deck keeps the object it started and refreshes it in place.
    const fresh = [track('t1'), track('t2')];
    await act(async () => {
      feed!(snapshot(fresh));
    });
    expect(api.currentTrack).toBe(held);

    await act(async () => {
      api.applyTrackTitle('t1', 'Morning Rain');
    });

    expect(api.currentTrack?.title).toBe('Morning Rain');
    expect(held.title).toBe('Morning Rain');
    expect(fresh[0]!.title).toBe('Morning Rain');
    expect(sheetTitle('t1')).toBe('Morning Rain');
    expect(sheetTitle('t2')).toBe('t2');
  });

  it('reaches an upcoming Track in the projection and the Queue sheet', async () => {
    await mount();
    await feedAndPlay([track('t1'), track('t2')]);

    await act(async () => {
      api.applyTrackTitle('t2', 'Evening Tide');
    });

    expect(api.peekNeighbors().next?.title).toBe('Evening Tide');
    expect(sheetTitle('t2')).toBe('Evening Tide');
    expect(api.currentTrack?.title).toBe('t1');
    expect(sheetTitle('t1')).toBe('t1');
  });
});
