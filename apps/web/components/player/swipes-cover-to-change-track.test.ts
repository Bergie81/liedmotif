// @vitest-environment jsdom

// Swiping the player cover sideways steps through the Tracks like the
// transport's Skip and Previous, with the neighbor's artwork beside the cover
// during the drag. A short or mostly-vertical drag (a page scroll) changes
// nothing.

import { createElement as h, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayableTrack } from './playable-track';
import { PlayerCoverSleeve } from './player-cover-sleeve';

beforeAll(() => {
  // jsdom implements no pointer capture and no image decoding.
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLImageElement.prototype.decode = () => Promise.resolve();
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const trackWithCover = (coverImageId: string) => ({ coverImageId }) as PlayableTrack;

const BOTH_SIDES = {
  next: trackWithCover('next-cover'),
  previous: trackWithCover('previous-cover'),
};

function renderCover(
  neighbors: { next: PlayableTrack; previous: PlayableTrack | null } = BOTH_SIDES,
  artwork: ReactNode = h('div', null, 'artwork'),
) {
  const onSwipeNext = vi.fn();
  const onSwipePrevious = vi.fn();
  const player = {
    currentTrack: { trackId: 'track-1' } as PlayableTrack,
    getPlaybackSample: vi.fn(),
    seekTo: vi.fn(),
    sessionCoverImageId: null,
    peekNeighbors: () => neighbors,
    skip: onSwipeNext,
    previous: onSwipePrevious,
  };
  const sleeve = (children: ReactNode) =>
    h(PlayerCoverSleeve, {
      player,
      session: null,
      coverImageId: null,
      lyricsAvailable: false,
      onExpandLyrics: vi.fn(),
      children,
    });
  const { rerender } = render(sleeve(artwork));
  return {
    onSwipeNext,
    onSwipePrevious,
    showArtwork: (next: ReactNode) => rerender(sleeve(next)),
  };
}

function drag(dx: number, dy = 0) {
  const cover = screen.getByTestId('player-cover');
  fireEvent.pointerDown(cover, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
  fireEvent.pointerMove(cover, { pointerId: 1, clientX: 200 + dx, clientY: 200 + dy });
}

function release(dx: number, dy = 0) {
  fireEvent.pointerUp(screen.getByTestId('player-cover'), {
    pointerId: 1,
    clientX: 200 + dx,
    clientY: 200 + dy,
  });
  // Past the slide, short of the artwork wait's give-up.
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

function peekSources() {
  return screen
    .queryAllByTestId('cover-peek')
    .map((peek) => peek.querySelector('img')?.getAttribute('src'));
}

describe('player cover swipe', () => {
  it('shows the neighbor covers beside the cover while dragging, and clears them after', () => {
    renderCover();
    drag(-40);
    expect(peekSources()).toEqual(['/api/covers/previous-cover', '/api/covers/next-cover']);
    release(-40);
    expect(peekSources()).toEqual([]);
  });

  it('shows no previous cover before the first Track', () => {
    renderCover({ next: BOTH_SIDES.next, previous: null });
    drag(40);
    expect(peekSources()).toEqual(['/api/covers/next-cover']);
  });

  // Previous with nothing before it restarts the Track, which the dead-end drag never showed.
  it('springs back from a swipe right before the first Track', () => {
    const { onSwipePrevious } = renderCover({ next: BOTH_SIDES.next, previous: null });
    drag(120);
    release(120);
    expect(onSwipePrevious).not.toHaveBeenCalled();
    expect(screen.getByTestId('player-cover').style.transform).toBe('');
  });

  it('goes to the next Track on a swipe left', () => {
    const { onSwipeNext, onSwipePrevious } = renderCover();
    drag(-120);
    release(-120);
    expect(onSwipeNext).toHaveBeenCalledOnce();
    expect(onSwipePrevious).not.toHaveBeenCalled();
  });

  it('goes to the previous Track on a swipe right', () => {
    const { onSwipeNext, onSwipePrevious } = renderCover();
    drag(120);
    release(120);
    expect(onSwipePrevious).toHaveBeenCalledOnce();
    expect(onSwipeNext).not.toHaveBeenCalled();
  });

  // Snapping back before the new artwork can paint flashes an empty cover.
  it('keeps the landed neighbor in place until the new artwork is decoded', async () => {
    let decoded!: () => void;
    vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(
      () => new Promise<void>((resolve) => (decoded = resolve)),
    );
    const { onSwipeNext, showArtwork } = renderCover(
      BOTH_SIDES,
      h('img', { alt: '', src: '/cover.png' }),
    );
    drag(-120);
    release(-120);
    showArtwork(h('img', { alt: '', src: '/api/covers/next-cover' }));
    act(() => {
      vi.advanceTimersByTime(50);
    });
    await act(async () => {});
    expect(onSwipeNext).toHaveBeenCalledOnce();
    expect(peekSources()).toEqual(['/api/covers/previous-cover', '/api/covers/next-cover']);

    await act(async () => {
      decoded();
    });
    expect(peekSources()).toEqual([]);
    expect(screen.getByTestId('player-cover').style.transform).toBe('');
  });

  // Decoding the old artwork resolves at once, so the neighbor would leave early and the old cover flash.
  it('keeps the landed neighbor in place until the cover shows the new artwork', async () => {
    const { showArtwork } = renderCover(BOTH_SIDES, h('img', { alt: '', src: '/cover.png' }));
    drag(-120);
    release(-120);
    await act(async () => {});
    expect(peekSources()).toEqual(['/api/covers/previous-cover', '/api/covers/next-cover']);

    showArtwork(h('img', { alt: '', src: '/api/covers/next-cover' }));
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(peekSources()).toEqual([]);
  });

  it('ignores a short drag and springs the cover back', () => {
    const { onSwipeNext, onSwipePrevious } = renderCover();
    drag(-30);
    release(-30);
    expect(onSwipeNext).not.toHaveBeenCalled();
    expect(onSwipePrevious).not.toHaveBeenCalled();
    expect(screen.getByTestId('player-cover').style.transform).toBe('');
  });

  it('ignores a mostly-vertical drag', () => {
    const { onSwipeNext, onSwipePrevious } = renderCover();
    drag(-100, 160);
    release(-100, 160);
    expect(onSwipeNext).not.toHaveBeenCalled();
    expect(onSwipePrevious).not.toHaveBeenCalled();
  });
});
