// @vitest-environment jsdom

// The marking gesture. A fast flick delivers its pointer events faster than React
// renders between them, so the release must not depend on a render having landed.

import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayableTrack } from './playable-track';
import { SectionLoopBar } from './section-loop-bar';

const WIDTH = 1000;
const DURATION = 100;

const track = {
  queueItemId: 'q1',
  trackId: 't1',
  durationSeconds: DURATION,
  targetBpm: null,
  blendAnalysis: null,
} as unknown as PlayableTrack;

function mount(region: { startSeconds: number; endSeconds: number } | null = null) {
  const onSetLoop = vi.fn();
  const seekTo = vi.fn();
  const view = render(
    createElement(SectionLoopBar, {
      tool: { phase: 'ready', bars: [0.5, 1], durationSeconds: DURATION, region },
      onSetLoop,
      onClearLoop: () => undefined,
      track,
      trackNumber: 1,
      trackCount: 1,
      getPlaybackSample: () => ({
        positionSeconds: 40,
        durationSeconds: DURATION,
        playbackRate: 1,
      }),
      seekTo,
      staged: null,
    }),
  );
  const surface = view.getByTestId('section-loop-surface');
  surface.setPointerCapture = () => undefined;
  surface.getBoundingClientRect = () =>
    ({ left: 0, width: WIDTH, right: WIDTH, top: 0, bottom: 48, height: 48 }) as DOMRect;
  return { surface, onSetLoop, seekTo };
}

/** Every event of one gesture inside a single tick: no render between them. */
function gesture(surface: HTMLElement, ...xs: number[]) {
  const fire = (type: string, clientX: number) =>
    surface.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true }));
  fire('pointerdown', xs[0]!);
  for (const x of xs.slice(1, -1)) fire('pointermove', x);
  fire('pointerup', xs[xs.length - 1]!);
}

afterEach(cleanup);

describe('marking on the waveform', () => {
  it('a flick marks the loop even with no render during the drag', () => {
    const { surface, onSetLoop, seekTo } = mount();
    gesture(surface, 100, 200, 300);
    expect(onSetLoop).toHaveBeenCalledWith({ startSeconds: 10, endSeconds: 30 }, 10);
    expect(seekTo).not.toHaveBeenCalled();
  });

  it('marks backwards just the same', () => {
    const { surface, onSetLoop } = mount();
    gesture(surface, 300, 200, 100);
    expect(onSetLoop).toHaveBeenCalledWith({ startSeconds: 10, endSeconds: 30 }, 10);
  });

  it('counts the release position when no move event arrived at all', () => {
    const { surface, onSetLoop } = mount();
    gesture(surface, 100, 300);
    expect(onSetLoop).toHaveBeenCalledWith({ startSeconds: 10, endSeconds: 30 }, 10);
  });

  it('a press that stays put is a tap, and jumps', () => {
    const { surface, onSetLoop, seekTo } = mount();
    gesture(surface, 400, 403, 402);
    expect(seekTo).toHaveBeenCalledWith(40.2);
    expect(onSetLoop).not.toHaveBeenCalled();
  });

  it('dragging the end handle keeps the start and previews the seam', () => {
    const { surface, onSetLoop } = mount({ startSeconds: 10, endSeconds: 30 });
    gesture(surface, 300, 350, 400);
    expect(onSetLoop).toHaveBeenCalledWith({ startSeconds: 10, endSeconds: 40 }, 38);
  });

  it('dragging the start handle restarts from the new start', () => {
    const { surface, onSetLoop } = mount({ startSeconds: 10, endSeconds: 30 });
    gesture(surface, 100, 150, 200);
    expect(onSetLoop).toHaveBeenCalledWith({ startSeconds: 20, endSeconds: 30 }, 20);
  });

  it('the arrow keys seek, as the progress bar they replace does', () => {
    const { surface, seekTo } = mount();
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(seekTo.mock.calls).toEqual([[45], [35]]);
  });

  it('pressing a handle without moving it leaves the loop alone', () => {
    const { surface, onSetLoop, seekTo } = mount({ startSeconds: 10, endSeconds: 30 });
    gesture(surface, 300, 300);
    expect(onSetLoop).not.toHaveBeenCalled();
    expect(seekTo).not.toHaveBeenCalled();
  });
});
