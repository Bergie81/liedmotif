// @vitest-environment jsdom

// When new Tracks land in the Session, the slider's Track total ticks up with
// a brief lamp flash and screen readers hear how many arrived. The flash only
// ever means "new Tracks arrived": opening the player, switching Sessions, or
// losing a Track to a Dislike never lights it.

import { createElement as h } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColdStartNarration } from './cold-start-progress';
import type { PlayableTrack } from './playable-track';
import type { SessionActivity } from './player-presentation';
import { TrackProgress } from './track-progress';

beforeAll(() => {
  // Radix measures the slider thumb; jsdom has no layout observer.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // jsdom has no media queries; each case says whether motion is reduced.
  vi.stubGlobal(
    'matchMedia',
    () => ({ matches: reducedMotion, addEventListener() {}, removeEventListener() {} }) as never,
  );
});

/** What the platform answers for `(prefers-reduced-motion: reduce)`. */
let reducedMotion = false;

beforeEach(() => {
  reducedMotion = false;
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const TRACK = { queueItemId: 'queue-item-3', durationSeconds: 180 } as PlayableTrack;

const PLAYBACK = {
  getPlaybackSample: () => ({ positionSeconds: 30, durationSeconds: 180, playbackRate: 1 }),
  seekTo: () => undefined,
  staged: null,
};

/** Track 3 of `trackCount`, thirty seconds in, within one Session (the player
 * keys the slider by Session id, so a new `session` remounts it). Generation
 * appends at the tail, so by default the newest slot is the `trackCount`-th. */
function slider(
  trackCount: number,
  {
    session = 'session-a',
    newestQueueItemId = `queue-item-${trackCount}`,
    activity = null,
  }: {
    session?: string;
    newestQueueItemId?: string | null;
    activity?: SessionActivity | null;
  } = {},
) {
  return h(TrackProgress, {
    key: session,
    track: TRACK,
    trackNumber: 3,
    trackCount,
    newestQueueItemId,
    activity,
    ...PLAYBACK,
  });
}

/** A Playlist: the same slider, with no Session work behind it. */
function playlistSlider(trackCount: number) {
  return h(TrackProgress, { track: TRACK, trackNumber: 3, trackCount, ...PLAYBACK });
}

/** A cold start: nothing playable yet, the staged narration in the label slot. */
function coldStartSlider(trackCount: number) {
  const staged: ColdStartNarration = {
    copy: 'Writing the first track…',
    submittedAt: new Date().toISOString(),
  };
  return h(TrackProgress, {
    track: null,
    trackNumber: null,
    trackCount,
    getPlaybackSample: () => ({ positionSeconds: null, durationSeconds: null, playbackRate: 1 }),
    seekTo: () => undefined,
    staged,
  });
}

const total = () => screen.getByTestId('progress-track-total');
const announcer = () => screen.getByRole('status');

describe('TrackProgress — new Tracks ready', () => {
  it('flashes the risen total and announces the arrivals for about 1.5 s', () => {
    const view = render(slider(7));

    view.rerender(slider(9));

    expect(screen.getByTestId('progress-track-number').textContent).toBe('Track 3/9');
    expect(total().dataset.readyFlash).toBeDefined();
    expect(announcer().textContent).toBe('2 new tracks ready');

    act(() => vi.advanceTimersByTime(1500));

    expect(total().dataset.readyFlash).toBeUndefined();
    expect(announcer().textContent).toBe('');
  });

  it('announces a single arrival in the singular', () => {
    const view = render(slider(7));

    view.rerender(slider(8));

    expect(announcer().textContent).toBe('1 new track ready');
  });

  it('under reduced motion, announces the arrivals without the flash', () => {
    reducedMotion = true;
    const view = render(slider(7));

    view.rerender(slider(9));

    expect(total().dataset.readyFlash).toBeUndefined();
    expect(announcer().textContent).toBe('2 new tracks ready');
  });

  it('stays dark when the player opens on a Session that already has Tracks', () => {
    render(slider(9));

    expect(total().dataset.readyFlash).toBeUndefined();
    expect(announcer().textContent).toBe('');
  });

  it('stays dark when a Dislike removes a Track', () => {
    const view = render(slider(7));

    view.rerender(slider(6));

    expect(total().dataset.readyFlash).toBeUndefined();
    expect(announcer().textContent).toBe('');
  });

  it('stays dark when the player switches to a Session with more Tracks', () => {
    const view = render(slider(7, { session: 'session-a' }));

    view.rerender(slider(9, { session: 'session-b' }));

    expect(total().dataset.readyFlash).toBeUndefined();
    expect(announcer().textContent).toBe('');
  });

  it('stays quiet while the cold start lands its first Tracks', () => {
    const view = render(coldStartSlider(0));

    view.rerender(coldStartSlider(2));

    expect(announcer().textContent).not.toMatch(/ready/);
  });

  it('stays dark when the Queue first loads under an already-mounted slider', () => {
    const view = render(slider(0, { newestQueueItemId: null }));

    view.rerender(slider(9));

    expect(total().dataset.readyFlash).toBeUndefined();
    expect(announcer().textContent).toBe('');
  });

  it('stays dark when the read window widens over older Tracks', () => {
    // Jumping back past the played window pulls older slots into the read; the
    // newest slot is unchanged, so nothing arrived.
    const view = render(slider(31, { newestQueueItemId: 'queue-item-tail' }));

    view.rerender(slider(36, { newestQueueItemId: 'queue-item-tail' }));

    expect(total().dataset.readyFlash).toBeUndefined();
    expect(announcer().textContent).toBe('');
  });

  it('stays dark for a Playlist, which generates nothing', () => {
    const view = render(playlistSlider(0));
    view.rerender(playlistSlider(3));
    view.rerender(playlistSlider(5));

    expect(total().dataset.readyFlash).toBeUndefined();
    expect(announcer().textContent).toBe('');
  });

  it('drops the flash when a Track is removed mid-flash', () => {
    const view = render(slider(7));
    view.rerender(slider(9));

    view.rerender(slider(8, { newestQueueItemId: 'queue-item-9' }));

    expect(total().dataset.readyFlash).toBeUndefined();
    expect(announcer().textContent).toBe('');
  });

  it('adds up arrivals that land during one flash', () => {
    const view = render(slider(7));
    view.rerender(slider(8));

    view.rerender(slider(9));

    expect(total().dataset.readyFlash).toBeDefined();
    expect(announcer().textContent).toBe('2 new tracks ready');
  });

  it('keeps announcing the Session status alongside the arrivals', () => {
    const view = render(slider(7));
    view.rerender(slider(9));

    view.rerender(slider(9, { activity: { label: 'Changing vibe…', tone: 'active' } }));

    expect(announcer().textContent).toBe('2 new tracks ready. Changing vibe…');
  });
});
