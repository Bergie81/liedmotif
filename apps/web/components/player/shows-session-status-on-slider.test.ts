// @vitest-environment jsdom

// The progress slider is where the listener reads both where they are in the
// Session and what the Session is doing: "Track 3/7 · Generating 2". Active
// work is marked so the label tints and the rail breathes; a calm status
// (Repeat) is not; the cold-start narration owns the slot while it runs.

import { createElement as h } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
});

afterEach(cleanup);

const TRACK = { queueItemId: 'queue-item-3', durationSeconds: 180 } as PlayableTrack;

/** Track 3 of 7, thirty seconds in, unless the case says otherwise. */
function slider(props: {
  activity?: SessionActivity | null;
  staged?: ColdStartNarration | null;
  track?: PlayableTrack | null;
  trackNumber?: number | null;
  trackCount?: number;
}) {
  return h(TrackProgress, {
    track: props.track === undefined ? TRACK : props.track,
    trackNumber: props.trackNumber === undefined ? 3 : props.trackNumber,
    trackCount: props.trackCount ?? 7,
    getPlaybackSample: () => ({ positionSeconds: 30, durationSeconds: 180, playbackRate: 1 }),
    seekTo: () => undefined,
    staged: props.staged ?? null,
    activity: props.activity,
  });
}

const renderSlider = (props: Parameters<typeof slider>[0]) => render(slider(props));

describe('TrackProgress — Session status', () => {
  it('reads the Track position and the active work together, marked as active', () => {
    renderSlider({ activity: { label: 'Generating 2', tone: 'active' } });

    expect(screen.getByTestId('progress-track-number').textContent).toBe(
      'Track 3/7 · Generating 2',
    );
    expect(screen.getByTestId('track-progress').dataset.sessionActivity).toBe('active');
  });

  it('shows a calm status without the active marker', () => {
    renderSlider({ activity: { label: 'Repeat', tone: 'muted' } });

    expect(screen.getByTestId('progress-track-number').textContent).toBe('Track 3/7 · Repeat');
    expect(screen.getByTestId('track-progress').dataset.sessionActivity).not.toBe('active');
  });

  it('shows only the Track position when the Session is idle (or a Playlist plays)', () => {
    renderSlider({});

    expect(screen.getByTestId('progress-track-number').textContent).toBe('Track 3/7');
    expect(screen.getByTestId('track-progress').dataset.sessionActivity).toBeUndefined();
  });

  it('gives the label slot to the cold-start narration, hiding the status and its marker', () => {
    renderSlider({
      activity: { label: 'Generating 2', tone: 'active' },
      staged: { copy: 'Writing the first track…', submittedAt: new Date().toISOString() },
      track: null,
      trackNumber: null,
      trackCount: 0,
    });

    expect(screen.getByTestId('progress-stage').textContent).toBe('Writing the first track…');
    expect(screen.queryByText(/Generating/)).toBeNull();
    expect(screen.getByTestId('track-progress').dataset.sessionActivity).toBeUndefined();
  });

  it('announces the status politely to screen readers', () => {
    const view = renderSlider({ activity: { label: 'Generating 2', tone: 'active' } });
    const announcer = screen.getByRole('status');
    expect(announcer.getAttribute('aria-live')).toBe('polite');
    expect(announcer.getAttribute('aria-atomic')).toBe('true');
    expect(announcer.textContent).toBe('Generating 2');

    view.rerender(slider({ activity: { label: 'Changing vibe…', tone: 'active' } }));
    expect(announcer.textContent).toBe('Changing vibe…');
  });
});
