// @vitest-environment jsdom

// Another owner's Track kept offline plays for a week after this device last
// synced. Once a Playlist plays, that limit binds before every new start: the
// Track that is playing finishes, an expired Track is passed over, and when
// only expired Tracks are left playback ends. The listener's own Tracks never
// expire.
import { createElement, Fragment } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOUNGE_OFFLINE_EXPIRY_MS, offlineCopyPlayable } from '@/lib/offline/offline-sync-plan';
import type { PlayableTrack } from './playable-track';
import type { PlaybackControllerApi, PlayerControllerSource } from './playback-controller-api';
import { usePlaybackController } from './use-playback-controller';

const SYNCED_AT = Date.UTC(2026, 10, 1);

function scripted(el: HTMLAudioElement) {
  let paused = true;
  Object.defineProperty(el, 'currentTime', { value: 0, writable: true, configurable: true });
  Object.defineProperty(el, 'duration', { get: () => 30, configurable: true });
  Object.defineProperty(el, 'readyState', { get: () => 4, configurable: true });
  Object.defineProperty(el, 'paused', { get: () => paused, configurable: true });
  el.play = () => {
    paused = false;
    return Promise.resolve();
  };
  el.pause = () => {
    paused = true;
  };
  el.load = () => undefined;
  return {
    ended() {
      paused = true;
      el.dispatchEvent(new Event('ended'));
    },
  };
}

/** A Track stored on this device: `lounge…` ids are another owner's. */
function offlineTrack(id: string): PlayableTrack {
  return {
    queueItemId: id,
    trackId: id,
    queueState: 'queued',
    vibeSwitchSetAside: false,
    title: id,
    artist: null,
    originSessionTitle: null,
    durationSeconds: 30,
    coverImageId: null,
    savedAt: null,
    favoritedAt: null,
    inCuratedPlaylist: false,
    genreTags: [],
    vocalMode: 'instrumental',
    hasLyrics: false,
    downloadable: false,
    assets: { final: `blob:https://liedmotif.test/${id}`, stream: null },
    styleRevision: null,
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

async function playOffline(ids: string[]) {
  const source: PlayerControllerSource = {
    kind: 'playlist',
    playlistId: 'playlist:p1',
    tracks: ids.map(offlineTrack),
    startTrackId: null,
    offline: true,
    expired: (trackId) =>
      !offlineCopyPlayable({ fromLounge: trackId.startsWith('lounge') }, SYNCED_AT, Date.now()),
  };
  const view = render(createElement(Probe, { source }));
  const decks = {
    a: view.getByTestId('deck-a') as HTMLAudioElement,
    b: view.getByTestId('deck-b') as HTMLAudioElement,
  };
  const scripts = { a: scripted(decks.a), b: scripted(decks.b) };
  await act(async () => {});
  await act(async () => api.play());
  /** The audible Track ends on its own. */
  const ended = () =>
    act(async () => {
      const active = decks.a.getAttribute('src')?.endsWith(api.currentTrack?.trackId ?? '')
        ? 'a'
        : 'b';
      scripts[active].ended();
    });
  /** Every audio address the decks were handed since the probe started. */
  const loaded = () => [decks.a, decks.b].map((deck) => deck.getAttribute('src') ?? '');
  return { ended, loaded };
}

const weekPasses = () => vi.setSystemTime(SYNCED_AT + LOUNGE_OFFLINE_EXPIRY_MS + 1000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(SYNCED_AT + 1000);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => undefined)),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('offline playback past the week since the last sync', () => {
  it('an expired Lounge copy does not start after the current Track', async () => {
    const player = await playOffline(['own', 'lounge']);
    expect(api.currentTrack?.trackId).toBe('own');

    weekPasses();
    await player.ended();

    expect(api.currentTrack?.trackId).toBe('own');
    expect(player.loaded().some((src) => src.includes('lounge'))).toBe(false);
  });

  it('lets the Track playing when the week passes play to its end, the Lounge copy itself too', async () => {
    const player = await playOffline(['lounge', 'own']);
    expect(api.currentTrack?.trackId).toBe('lounge');

    weekPasses();
    expect(api.currentTrack?.trackId).toBe('lounge');
    expect(api.status).toBe('playing');

    await player.ended();
    expect(api.currentTrack?.trackId).toBe('own');
  });

  it('ends playback when only expired Tracks are left, and Play does not loop them', async () => {
    const player = await playOffline(['lounge-1', 'lounge-2']);

    weekPasses();
    await player.ended();

    expect(api.status).toBe('ended');
    expect(api.currentTrack).toBeNull();
    expect(player.loaded()).not.toContain('blob:https://liedmotif.test/lounge-2');

    await act(async () => api.play());
    expect(api.status).toBe('ended');
    expect(api.currentTrack).toBeNull();
  });

  it('passes over an expired Track on Skip and Back, and a tap cannot start it', async () => {
    await playOffline(['own-1', 'lounge', 'own-2']);

    weekPasses();
    await act(async () => api.skip());
    expect(api.currentTrack?.trackId).toBe('own-2');

    await act(async () => api.previous());
    expect(api.currentTrack?.trackId).toBe('own-1');

    await act(async () => api.playQueueItem('lounge'));
    expect(api.currentTrack?.trackId).toBe('own-1');
  });

  it('gives an expired Track on Loop Track no further pass', async () => {
    const player = await playOffline(['lounge', 'own']);
    await act(async () => api.setPlaybackMode('loop-track'));

    weekPasses();
    await player.ended();

    expect(api.currentTrack?.trackId).toBe('own');
  });

  it('never expires the listener’s own Tracks', async () => {
    const player = await playOffline(['own-1', 'own-2']);

    weekPasses();
    await player.ended();
    expect(api.currentTrack?.trackId).toBe('own-2');
    await player.ended();
    expect(api.currentTrack?.trackId).toBe('own-1');
  });
});
