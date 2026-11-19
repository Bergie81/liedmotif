// @vitest-environment jsdom

// The play intent through the real controller over a fed Session Queue and
// scripted media elements: a fresh start must survive the source ladder's
// step-down (its superseded play() rejects), and nothing autonomous may start
// audio while the listener has paused.
import { createElement, Fragment } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackMode } from '@liedmotif/shared';
import type { PlayableTrack } from './playable-track';
import type { PlaybackControllerApi, PlayerControllerSource } from './playback-controller-api';
import { usePlaybackController } from './use-playback-controller';
import type { SessionQueueSnapshot } from './use-session-queue';

const reportPlayback = vi.fn();
const leaseActions = vi.hoisted(() => [] as string[]);

vi.mock('@/lib/http/api-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    reportPlayback: (body: unknown) => reportPlayback(body),
    reportListening: vi.fn(async () => ({ ok: true, data: {} })),
    applyLoopLease: vi.fn(async ({ action }: { action: string }) => {
      leaseActions.push(action);
      return {
        ok: true,
        data: {
          applied: true,
          held: action !== 'release',
          lease: { released: action === 'release' },
        },
      };
    }),
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

interface Deck {
  el: HTMLAudioElement;
  plays: number;
  rejectNext: (() => void) | null;
  manual: boolean;
  pendingResolves: Array<() => void>;
  ended(): void;
  fail(): void;
}

function script(el: HTMLAudioElement): Deck {
  let paused = true;
  let errorValue: unknown = null;
  const deck: Deck = {
    el,
    plays: 0,
    rejectNext: null,
    manual: false,
    pendingResolves: [],
    ended() {
      paused = true;
      el.dispatchEvent(new Event('ended'));
    },
    fail() {
      errorValue = { code: 4 };
      el.dispatchEvent(new Event('error'));
    },
  };
  Object.defineProperty(el, 'currentTime', { value: 0, writable: true, configurable: true });
  Object.defineProperty(el, 'duration', { get: () => 30, configurable: true });
  Object.defineProperty(el, 'readyState', { value: 0, configurable: true });
  Object.defineProperty(el, 'paused', { get: () => paused, configurable: true });
  Object.defineProperty(el, 'error', { get: () => errorValue, configurable: true });
  el.play = () => {
    deck.plays += 1;
    if (deck.manual) {
      return new Promise<void>((resolve, reject) => {
        deck.rejectNext = () => reject(new DOMException('aborted', 'AbortError'));
        deck.pendingResolves.push(() => {
          paused = false;
          resolve();
        });
      });
    }
    paused = false;
    return Promise.resolve();
  };
  el.pause = () => {
    paused = true;
  };
  el.load = () => {
    errorValue = null;
  };
  return deck;
}

function track(id: string, opts: { stream?: boolean; rev?: number } = {}): PlayableTrack {
  return {
    queueState: 'queued',
    vibeSwitchSetAside: false,
    queueItemId: id,
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
    assets: {
      final: `/api/audio/${id}?asset=final`,
      stream: opts.stream ? `/api/audio/${id}?asset=stream` : null,
    },
    styleRevision: opts.rev ?? 1,
    targetBpm: null,
    targetKey: null,
    blendAnalysis: null,
  };
}

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
    ...extra,
  } as SessionQueueSnapshot;
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

async function mount() {
  const view = render(createElement(Probe, { source: { kind: 'session', sessionId: 's1' } }));
  const decks = {
    a: script(view.getByTestId('deck-a') as HTMLAudioElement),
    b: script(view.getByTestId('deck-b') as HTMLAudioElement),
  };
  await act(async () => {});
  return decks;
}

const startedFor = (id: string) =>
  reportPlayback.mock.calls.filter(
    ([body]) =>
      (body as { type: string; trackId: string }).type === 'started' &&
      (body as { trackId: string }).trackId === id,
  ).length;

afterEach(() => {
  cleanup();
  reportPlayback.mockClear();
  leaseActions.length = 0;
  feed = null;
});

describe('play intent through the real controller (Session source, scripted decks)', () => {
  it('a source step-down during a fresh start still reports started and keeps the play intent', async () => {
    const decks = await mount();
    await act(async () => {
      feed!(snapshot([track('t1', { stream: true }), track('t2', { stream: true })]));
    });
    decks.a.manual = true;
    await act(async () => {
      api.play();
    });
    const rejectFirst = decks.a.rejectNext!;
    // The pinned final fails: the ladder steps down to the stream and plays
    // again, and the browser rejects the superseded first play().
    await act(async () => {
      decks.a.fail();
    });
    expect(decks.a.plays).toBe(2);
    await act(async () => {
      rejectFirst();
    });
    await act(async () => {
      decks.a.pendingResolves.at(-1)!();
    });
    expect(api.status).toBe('playing');
    expect(startedFor('t1')).toBe(1);
    // The play intent survived: t2's failing final steps down and resumes.
    decks.b.manual = false;
    await act(async () => {
      decks.a.ended();
    });
    const before = decks.b.plays;
    await act(async () => {
      decks.b.fail();
    });
    expect(decks.b.plays).toBe(before + 1);
  });

  it('Play after a browser-blocked fresh start reports the start it still owes', async () => {
    const decks = await mount();
    await act(async () => {
      feed!(snapshot([track('t1'), track('t2')]));
    });
    decks.a.manual = true;
    await act(async () => {
      api.play();
    });
    await act(async () => {
      decks.a.rejectNext!();
    });
    expect(api.status).toBe('ready');
    expect(startedFor('t1')).toBe(0);

    decks.a.manual = false;
    await act(async () => {
      api.toggle();
    });
    expect(api.status).toBe('playing');
    expect(startedFor('t1')).toBe(1);

    // A later pause and resume continue the same listen.
    await act(async () => {
      api.toggle();
    });
    await act(async () => {
      api.toggle();
    });
    expect(startedFor('t1')).toBe(1);
  });

  it('the toggle pauses a start still pending, as its Pause label says', async () => {
    const decks = await mount();
    await act(async () => {
      feed!(snapshot([track('t1')]));
    });
    decks.a.manual = true;
    await act(async () => {
      api.play();
    });
    expect(api.playIntentPending).toBe(true);

    await act(async () => {
      api.toggle();
    });
    expect(decks.a.plays).toBe(1);
    expect(decks.a.el.paused).toBe(true);
    // The browser aborts the pending play() the pause interrupted.
    await act(async () => {
      decks.a.rejectNext!();
    });
    expect(api.status).not.toBe('playing');
    expect(api.playIntentPending).toBe(false);
  });

  it('a switch-now cutover never starts audio the listener paused', async () => {
    const decks = await mount();
    await act(async () => {
      feed!(
        snapshot([track('t1', { rev: 1 }), track('t2', { rev: 1 })], {
          switchPending: true,
          styleRevision: 2,
        }),
      );
    });
    await act(async () => {
      api.play();
    });
    await act(async () => {
      api.pause();
    });
    const playsB = decks.b.plays;
    // The server performed the cutover: t3 carries the new vibe.
    await act(async () => {
      feed!(
        snapshot([track('t1', { rev: 1 }), track('t3', { rev: 2 })], {
          switchPending: false,
          styleRevision: 2,
        }),
      );
    });
    expect(decks.b.plays).toBe(playsB);
    expect(api.currentTrack?.trackId).toBe('t1');
  });
});

describe('advancing off dead audio (Session source, scripted decks)', () => {
  const failedReports = () =>
    reportPlayback.mock.calls.filter(([body]) => (body as { type: string }).type === 'failed')
      .length;
  const totalPlays = (decks: { a: Deck; b: Deck }) => decks.a.plays + decks.b.plays;
  const loaded = (decks: { a: Deck; b: Deck }) =>
    decks.a.el.getAttribute('src') ? decks.a : decks.b;
  // Dead audio never resolves play(): the element errors instead.
  const step = async (decks: { a: Deck; b: Deck }, outcome: 'fail' | 'start' | 'end') => {
    const deck = loaded(decks);
    await act(async () => {
      if (outcome === 'fail') deck.fail();
      else if (outcome === 'start') deck.pendingResolves.at(-1)!();
      else deck.ended();
    });
  };
  const mountManual = async (tracks: PlayableTrack[], mode: PlaybackMode = 'loop-session') => {
    const decks = await mount();
    decks.a.manual = true;
    decks.b.manual = true;
    await act(async () => {
      feed!(snapshot(tracks));
    });
    while (api.playbackMode !== mode) {
      await act(async () => {
        api.cyclePlaybackMode();
      });
    }
    await act(async () => {
      api.play();
    });
    return decks;
  };

  it.each(['loop-session', 'shuffle'] as const)(
    'tries each dead Track once, then waits and retries one Track per poll (%s)',
    async (mode) => {
      const queue = [track('t1'), track('t2'), track('t3')];
      const decks = await mountManual(queue, mode);
      for (let attempt = 0; attempt < 6 && api.status !== 'waiting'; attempt += 1) {
        await step(decks, 'fail');
      }
      expect(failedReports()).toBe(3);
      expect(totalPlays(decks)).toBe(3);
      expect(api.status).toBe('waiting');

      await act(async () => {
        feed!(snapshot(queue));
      });
      expect(totalPlays(decks)).toBe(4);
      expect(api.status).toBe('waiting');
      await step(decks, 'fail');
      expect(failedReports()).toBe(4);
      expect(totalPlays(decks)).toBe(4);
      expect(api.status).toBe('waiting');

      // The audio is back: the next poll's retry plays.
      await act(async () => {
        feed!(snapshot(queue));
      });
      await step(decks, 'start');
      expect(api.status).toBe('playing');
    },
  );

  it('moves its once-per-poll retry along the Queue, so playback returns once any Track does', async () => {
    const queue = [track('t1'), track('t2')];
    const decks = await mountManual(queue);
    await step(decks, 'fail');
    await step(decks, 'fail');
    expect(api.status).toBe('waiting');

    // t2's audio is gone for good; t1's comes back.
    for (let poll = 0; poll < 3 && api.status !== 'playing'; poll += 1) {
      const plays = totalPlays(decks);
      await act(async () => {
        feed!(snapshot(queue));
      });
      expect(totalPlays(decks)).toBe(plays + 1);
      const retried = loaded(decks).el.getAttribute('src') ?? '';
      await step(decks, retried.includes('/t1') ? 'start' : 'fail');
    }
    expect(api.status).toBe('playing');
    expect(startedFor('t1')).toBe(1);
  });

  it('keeps looping the healthy Tracks past a dead one', async () => {
    const decks = await mountManual([track('t1'), track('t2'), track('t3')]);
    await step(decks, 'start');
    for (let lap = 0; lap < 2; lap += 1) {
      await step(decks, 'end');
      await step(decks, 'fail');
      await step(decks, 'start');
      await step(decks, 'end');
      await step(decks, 'start');
    }
    expect(startedFor('t1')).toBe(3);
    expect(startedFor('t2')).toBe(0);
    expect(startedFor('t3')).toBe(2);
    expect(failedReports()).toBe(2);
    expect(api.status).toBe('playing');
  });
});

describe("Loop Track's generation hold (Session source, scripted decks)", () => {
  const streaming = (id: string): PlayableTrack => ({
    ...track(id),
    assets: { final: null, stream: `/api/audio/${id}?asset=stream` },
  });
  const commitSource = async (deck: Deck) => {
    Object.defineProperty(deck.el, 'readyState', { value: 4, configurable: true });
    await act(async () => {
      deck.el.dispatchEvent(new Event('canplay'));
    });
  };
  const toMode = async (mode: PlaybackMode) => {
    while (api.playbackMode !== mode) {
      await act(async () => {
        api.cyclePlaybackMode();
      });
    }
  };

  it('holds new generation while Loop Track plays a Track still on its stream', async () => {
    const decks = await mount();
    await act(async () => {
      feed!(snapshot([streaming('t1'), track('t2')]));
    });
    await act(async () => {
      api.play();
    });
    await commitSource(decks.a);
    await toMode('loop-track');
    expect(leaseActions).toEqual(['acquire']);

    // The replay re-runs the ladder and commits the stream again: the hold stands.
    await act(async () => {
      decks.a.ended();
    });
    await commitSource(decks.b);
    expect(leaseActions).toEqual(['acquire']);

    // Leaving Loop Track lets generation run again.
    await toMode('shuffle');
    expect(leaseActions).toEqual(['acquire', 'release']);
  });

  it('a Change Vibe leaves Loop Track, so the Track is not held again', async () => {
    const decks = await mount();
    await act(async () => {
      feed!(snapshot([streaming('t1'), track('t2')]));
    });
    await act(async () => {
      api.play();
    });
    await commitSource(decks.a);
    await toMode('loop-track');
    expect(leaseActions).toEqual(['acquire']);

    // A Change Vibe in any tab shows up as a moved style revision in the poll.
    await act(async () => {
      feed!(snapshot([streaming('t1'), track('t2')], { styleRevision: 2 }));
    });
    expect(api.playbackMode).toBe('loop-session');
    expect(leaseActions).toEqual(['acquire', 'release']);
    expect(startedFor('t2')).toBe(0);

    // The looped Track plays out; the Queue moves on and nothing holds again.
    await act(async () => {
      decks.a.ended();
    });
    await commitSource(decks.b);
    expect(startedFor('t1')).toBe(1);
    expect(startedFor('t2')).toBe(1);
    expect(leaseActions).toEqual(['acquire', 'release']);
  });

  it('Loop Track chosen again after a Change Vibe loops and holds as usual', async () => {
    const decks = await mount();
    await act(async () => {
      feed!(snapshot([streaming('t1'), track('t2')]));
    });
    await act(async () => {
      api.play();
    });
    await commitSource(decks.a);
    await toMode('loop-track');
    await act(async () => {
      feed!(snapshot([streaming('t1'), track('t2')], { styleRevision: 2 }));
    });

    await toMode('loop-track');
    expect(leaseActions).toEqual(['acquire', 'release', 'acquire']);

    // A later poll at the same revision is no new Change Vibe: the loop stands.
    await act(async () => {
      feed!(snapshot([streaming('t1'), track('t2')], { styleRevision: 2 }));
    });
    await act(async () => {
      decks.a.ended();
    });
    await commitSource(decks.b);
    expect(api.playbackMode).toBe('loop-track');
    expect(startedFor('t2')).toBe(0);
    expect(leaseActions).toEqual(['acquire', 'release', 'acquire']);
  });
});
