// @vitest-environment jsdom

// The Section loop through the real controller, over scripted media elements and
// a fake Web Audio graph: what the listener can do with the tool, and every way a
// loop has to end. A Playlist source feeds the queue, so nothing polls.

import { createElement, Fragment } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayerEngine } from './audio-engine';
import type { BlendEdgeEventDetail, PlayableTrack } from './playable-track';
import type { PlaybackControllerApi, PlayerControllerSource } from './playback-controller-api';
import { usePlaybackController } from './use-playback-controller';

const TRACK_SECONDS = 30;
const REGION = { startSeconds: 10, endSeconds: 14 };

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

interface FakeSource {
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  started: Array<{ when: number; offset: number }>;
  stopped: number;
  onended: (() => void) | null;
}

class FakeAudioContext {
  static latest: FakeAudioContext;
  currentTime = 100;
  state = 'running';
  destination = fakeNode();
  sources: FakeSource[] = [];
  decodeFails = false;
  constructor() {
    FakeAudioContext.latest = this;
  }
  createGain = () => fakeNode();
  createBiquadFilter = () => fakeNode();
  createDynamicsCompressor = () => fakeNode();
  createMediaElementSource = () => fakeNode();
  createBufferSource = () => {
    const source: FakeSource = {
      loop: false,
      loopStart: 0,
      loopEnd: 0,
      started: [],
      stopped: 0,
      onended: null,
    };
    this.sources.push(source);
    return Object.assign(source, {
      buffer: null,
      playbackRate: { value: 1 },
      connect: () => undefined,
      disconnect: () => undefined,
      start(when = 0, offset = 0) {
        source.started.push({ when, offset });
      },
      stop() {
        source.stopped += 1;
      },
    });
  };
  decodeAudioData = () =>
    this.decodeFails
      ? Promise.reject(new DOMException('EncodingError'))
      : Promise.resolve({
          duration: TRACK_SECONDS,
          sampleRate: 48000,
          getChannelData: () => Float32Array.from([1, 1, 1, 1]),
        } as unknown as AudioBuffer);
  resume = () => Promise.resolve();
  close = () => Promise.resolve();
  addEventListener = () => undefined;
  removeEventListener = () => undefined;
}

interface ScriptedDeck {
  el: HTMLAudioElement;
  ready(): void;
  tick(seconds: number): void;
  readonly playing: boolean;
}

function script(el: HTMLAudioElement): ScriptedDeck {
  let currentTime = 0;
  let readyState = 0;
  let paused = true;
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
    readyState = 0;
    currentTime = 0;
  };
  return {
    el,
    ready() {
      readyState = 4;
      el.dispatchEvent(new Event('canplay'));
    },
    tick(seconds: number) {
      currentTime = seconds;
      el.dispatchEvent(new Event('timeupdate'));
    },
    get playing() {
      return !paused;
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

async function mountPlaying(trackIds = ['t1', 't2']) {
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
        json: async () => ({
          ok: true,
          data: String(url).includes('/api/settings/playback')
            ? { blendEnabled: true, crossfadeSeconds: 6 }
            : {},
        }),
      }),
    ),
  );
  const edges: BlendEdgeEventDetail[] = [];
  window.addEventListener('liedmotif:blend-edge', (event) => {
    edges.push((event as CustomEvent<BlendEdgeEventDetail>).detail);
  });
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
  await act(async () => {
    api.play();
  });
  await act(async () => {
    decks.a.ready();
  });
  return { decks, edges };
}

async function openTool() {
  await act(async () => {
    api.toggleSectionLoopTool();
  });
}

async function looping(from = REGION.startSeconds) {
  await openTool();
  await act(async () => {
    api.setSectionLoop(REGION, from);
  });
}

const context = () => FakeAudioContext.latest;
const lastSource = () => context().sources[context().sources.length - 1]!;
const region = () => (api.sectionLoopTool.phase === 'ready' ? api.sectionLoopTool.region : null);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('opening the tool', () => {
  it('starts closed and leaves the Track on its element', async () => {
    await mountPlaying();
    expect(api.sectionLoopTool).toEqual({ phase: 'closed' });
    expect(context().sources).toHaveLength(0);
  });

  it('decodes the final and offers its waveform, without touching playback', async () => {
    const { decks } = await mountPlaying();
    await openTool();
    expect(api.sectionLoopTool).toMatchObject({
      phase: 'ready',
      durationSeconds: TRACK_SECONDS,
      region: null,
    });
    expect(api.sectionLoopTool.phase === 'ready' && api.sectionLoopTool.bars).toHaveLength(96);
    expect(context().sources).toHaveLength(0);
    expect(decks.a.playing).toBe(true);
  });

  it('says it is unavailable when the final will not decode', async () => {
    await mountPlaying();
    context().decodeFails = true;
    await openTool();
    expect(api.sectionLoopTool).toEqual({ phase: 'unavailable' });
  });

  it('says it is unavailable when the Track has no final yet', async () => {
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ json: async () => ({ ok: true, data: {} }) })),
    );
    const streaming = {
      ...track('t1'),
      assets: { final: null, stream: '/api/audio/t1?asset=stream' },
    };
    const view = render(
      createElement(Probe, {
        source: { kind: 'playlist', playlistId: 'p', tracks: [streaming], startTrackId: 't1' },
      }),
    );
    const a = script(view.getByTestId('deck-a') as HTMLAudioElement);
    await act(async () => {});
    await act(async () => api.play());
    await act(async () => a.ready());
    await openTool();
    expect(api.sectionLoopTool).toEqual({ phase: 'unavailable' });
  });

  it('is refused on a device known to be too small', async () => {
    vi.stubGlobal('navigator', { ...navigator, deviceMemory: 2 });
    await mountPlaying();
    expect(api.sectionLoopAvailable).toBe(false);
    await openTool();
    expect(api.sectionLoopTool).toEqual({ phase: 'closed' });
  });

  it('is offered on a device that does not report its memory', async () => {
    await mountPlaying();
    expect(api.sectionLoopAvailable).toBe(true);
  });
});

describe('marking a loop', () => {
  it('moves the Track onto a repeating buffer, keeping the element as a muted carrier', async () => {
    const audible = vi.spyOn(PlayerEngine.prototype, 'setDeckMediaAudible');
    const { decks } = await mountPlaying();
    await looping();
    const source = lastSource();
    expect(source.loop).toBe(true);
    expect(source.loopStart).toBe(10);
    expect(source.loopEnd).toBe(14);
    expect(source.started).toEqual([{ when: context().currentTime, offset: 10 }]);
    expect(audible).toHaveBeenLastCalledWith('a', false);
    expect(decks.a.playing).toBe(true);
    expect(decks.a.el.loop).toBe(true);
    expect(region()).toEqual(REGION);
  });

  it('reports the true position through every pass', async () => {
    await mountPlaying();
    await looping();
    context().currentTime += 4 * 3 + 1;
    expect(api.getPlaybackSample().positionSeconds).toBeCloseTo(11);
  });

  it('stays paused when marked while paused, and repeats on Play', async () => {
    const { decks } = await mountPlaying();
    await act(async () => api.pause());
    await looping();
    expect(context().sources).toHaveLength(0);
    expect(decks.a.playing).toBe(false);
    expect(api.getPlaybackSample().positionSeconds).toBe(10);
    await act(async () => api.play());
    expect(lastSource().loop).toBe(true);
    expect(lastSource().started[0]!.offset).toBe(10);
    expect(decks.a.playing).toBe(true);
  });

  it('redrawing replaces the region on the buffer', async () => {
    await mountPlaying();
    await looping();
    await act(async () => {
      api.setSectionLoop({ startSeconds: 20, endSeconds: 25 }, 20);
    });
    expect(lastSource().loopStart).toBe(20);
    expect(lastSource().loopEnd).toBe(25);
    expect(context().sources.filter((source) => source.stopped === 0)).toHaveLength(1);
  });

  it('a redraw the buffer refuses keeps playing, even when the carrier had died', async () => {
    const { decks } = await mountPlaying();
    await looping();
    decks.a.el.pause();
    context().createBufferSource = () => {
      throw new Error('no more sources');
    };
    await act(async () => {
      api.setSectionLoop({ startSeconds: 20, endSeconds: 25 }, 20);
    });
    expect(region()).toBeNull();
    expect(decks.a.playing).toBe(true);
    expect(decks.a.el.currentTime).toBe(20);
  });

  it('prepares no edge while looping, even deep in the fade zone', async () => {
    const { decks, edges } = await mountPlaying();
    await openTool();
    // Fade start = 30 − 6 = 24 s, so this whole region sits past it.
    await act(async () => {
      api.setSectionLoop({ startSeconds: 25, endSeconds: 29 }, 25);
    });
    context().currentTime += 2;
    await act(async () => decks.a.tick(27));
    await act(async () => decks.b.ready());
    context().currentTime += 1;
    await act(async () => decks.a.tick(28));
    expect(decks.b.el.getAttribute('src')).toBeNull();
    expect(edges).toEqual([]);
    expect(api.currentTrack?.trackId).toBe('t1');
  });
});

describe('ending a loop', () => {
  it('stopping lets the same audio play on, with the tool still open', async () => {
    const { decks } = await mountPlaying();
    await looping();
    const source = lastSource();
    const count = context().sources.length;
    await act(async () => api.clearSectionLoop());
    expect(context().sources).toHaveLength(count);
    expect(source.loop).toBe(false);
    expect(source.stopped).toBe(0);
    expect(decks.a.el.loop).toBe(false);
    expect(api.sectionLoopTool).toMatchObject({ phase: 'ready', region: null });
  });

  it('closing the tool ends the loop the same way', async () => {
    await mountPlaying();
    await looping();
    const source = lastSource();
    await openTool();
    expect(api.sectionLoopTool).toEqual({ phase: 'closed' });
    expect(source.loop).toBe(false);
    expect(source.stopped).toBe(0);
  });

  it('Skip ends it and the next Track plays on its element with the tool open', async () => {
    const audible = vi.spyOn(PlayerEngine.prototype, 'setDeckMediaAudible');
    const { decks } = await mountPlaying();
    await looping();
    const source = lastSource();
    await act(async () => api.skip());
    await act(async () => decks.a.ready());
    expect(source.stopped).toBe(1);
    expect(decks.a.el.loop).toBe(false);
    expect(audible).toHaveBeenLastCalledWith('a', true);
    expect(api.currentTrack?.trackId).toBe('t2');
    expect(api.sectionLoopTool).toMatchObject({ phase: 'ready', region: null });
  });

  it('a Queue tap ends it', async () => {
    const { decks } = await mountPlaying();
    await looping();
    await act(async () => api.playQueueItem('t2'));
    await act(async () => decks.a.ready());
    expect(region()).toBeNull();
    expect(decks.a.el.loop).toBe(false);
  });

  it('a seek inside the region keeps it', async () => {
    await mountPlaying();
    await looping();
    await act(async () => api.seekTo(12));
    expect(region()).toEqual(REGION);
    expect(lastSource().loop).toBe(true);
    expect(lastSource().started[0]!.offset).toBe(12);
  });

  it('a seek outside the region ends it, and playback lands there', async () => {
    const { decks } = await mountPlaying();
    await looping();
    await act(async () => api.seekTo(20));
    expect(region()).toBeNull();
    expect(lastSource().loop).toBe(false);
    expect(decks.a.el.loop).toBe(false);
    expect(api.getPlaybackSample().positionSeconds).toBeCloseTo(20);
  });

  it('Back jumps to the start of the loop and keeps it', async () => {
    await mountPlaying();
    await looping();
    context().currentTime += 2;
    await act(async () => api.back());
    expect(region()).toEqual(REGION);
    expect(api.currentTrack?.trackId).toBe('t1');
    expect(lastSource().started[0]!.offset).toBe(10);
  });

  it('edges work again once the loop has ended', async () => {
    const { decks } = await mountPlaying();
    await looping();
    await act(async () => api.clearSectionLoop());
    expect(decks.b.el.getAttribute('src')).toBeNull();
    // From 10 s, past the 16 s preparation lead (fade start 24 s, 8 s ahead).
    context().currentTime += 8;
    await act(async () => decks.a.tick(18));
    expect(decks.b.el.getAttribute('src')).toContain('t2');
  });
});
