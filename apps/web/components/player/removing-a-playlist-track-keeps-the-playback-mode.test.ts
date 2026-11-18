// @vitest-environment jsdom

// Removing a Track from the Playlist that is playing changes the list, never
// the listening: the selected mode, the shuffle state and the audible Track's
// position stay, and the removed Track never plays again in this engagement.
// The real controller over scripted decks and a fake Web Audio graph, so a
// deck already prepared for a blend is exercised as the player runs it.

import { createElement, Fragment } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayableTrack } from './playable-track';
import type { PlaybackControllerApi, PlayerControllerSource } from './playback-controller-api';
import { usePlaybackController } from './use-playback-controller';

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

const TRACK_SECONDS = 30;

interface ScriptedDeck {
  ready(): void;
  tick(seconds: number): void;
  end(): void;
  readonly currentTime: number;
  readonly loads: number;
}

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
    get currentTime() {
      return currentTime;
    },
    get loads() {
      return loads;
    },
  };
}

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

async function playPlaylist(trackIds: string[]) {
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve({
        json: async () =>
          String(url).includes('/api/settings/playback')
            ? { ok: true, data: { blendEnabled: true, crossfadeSeconds: 6 } }
            : { ok: true, data: {} },
      }),
    ),
  );
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
  await act(async () => {});
  await act(async () => api.play());
  await act(async () => decks.a.ready());
  return decks;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('removing a Track from the playing Playlist', () => {
  it('keeps Shuffle selected and plays the next Track when the audible one is removed', async () => {
    await playPlaylist(['t1', 't2', 't3', 't4']);
    await act(async () => api.setPlaybackMode('shuffle'));
    const removed = api.currentTrack!.trackId;

    await act(async () => api.advancePastDeletedTrack(removed));

    expect(api.playbackMode).toBe('shuffle');
    expect(api.currentTrack?.trackId).not.toBe(removed);
    expect(api.trackCount).toBe(3);

    // The removed Track left the shuffle bag and the shuffle history.
    const heard: string[] = [api.currentTrack!.trackId];
    for (let step = 0; step < 6; step += 1) {
      await act(async () => api.skip());
      heard.push(api.currentTrack!.trackId);
    }
    await act(async () => api.previous());
    heard.push(api.currentTrack!.trackId);
    expect(heard).not.toContain(removed);
  });

  it('leaves the audible Track playing where it is when another Track is removed', async () => {
    const decks = await playPlaylist(['t1', 't2', 't3']);
    await act(async () => decks.a.tick(9));
    const loadsBefore = decks.a.loads;

    await act(async () => api.advancePastDeletedTrack('t2'));

    expect(api.currentTrack?.trackId).toBe('t1');
    expect(decks.a.currentTime).toBe(9);
    expect(decks.a.loads).toBe(loadsBefore);
    expect(api.trackCount).toBe(2);

    await act(async () => decks.a.end());
    expect(api.currentTrack?.trackId).toBe('t3');
  });

  it('never starts a deck that was already prepared with the removed Track', async () => {
    const decks = await playPlaylist(['t1', 't2', 't3']);
    // Into the preparation lead: deck B loads t2 for the blend and is ready.
    await act(async () => decks.a.tick(17));
    await act(async () => decks.b.ready());

    await act(async () => api.advancePastDeletedTrack('t2'));
    await act(async () => decks.a.tick(24.2));
    expect(api.currentTrack?.trackId).not.toBe('t2');

    await act(async () => decks.b.ready());
    await act(async () => decks.a.tick(25));
    await act(async () => decks.a.end());
    expect(api.currentTrack?.trackId).toBe('t3');
  });
});
