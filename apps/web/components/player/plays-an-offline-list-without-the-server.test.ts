// @vitest-environment jsdom

// The Offline Library hands the Player a Track list whose audio lives on the
// device. Playing it — start, advance, skip, pause — must not reach for the
// server at all: no listening report, no playback settings read, nothing.
import { createElement, Fragment } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayableTrack } from './playable-track';
import type { PlaybackControllerApi, PlayerControllerSource } from './playback-controller-api';
import { usePlaybackController } from './use-playback-controller';

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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('an offline Track list', () => {
  it('plays start to finish without a single request to the server', async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetch);
    const source: PlayerControllerSource = {
      kind: 'playlist',
      playlistId: 'playlist:p1',
      tracks: [offlineTrack('t1'), offlineTrack('t2'), offlineTrack('t3')],
      startTrackId: null,
      offline: true,
    };
    const view = render(createElement(Probe, { source }));
    const decks = {
      a: scripted(view.getByTestId('deck-a') as HTMLAudioElement),
      b: scripted(view.getByTestId('deck-b') as HTMLAudioElement),
    };
    await act(async () => {});

    await act(async () => api.play());
    expect(api.currentTrack?.trackId).toBe('t1');
    await act(async () => decks.a.ended());
    expect(api.currentTrack?.trackId).toBe('t2');
    await act(async () => api.skip());
    expect(api.currentTrack?.trackId).toBe('t3');
    await act(async () => api.pause());
    // The page hiding flushes whatever listening a meter holds.
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    view.unmount();

    expect(fetch).not.toHaveBeenCalled();
  });
});
