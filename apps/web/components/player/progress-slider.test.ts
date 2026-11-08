// The progress slider's geometry (cold-start stream fix): while the Track
// length is unknown — the early stream phase, before the provider reports a
// duration — the bar must render EMPTY and unseekable, never a full bar that
// reads as "played to the end" one second into playback.

import { describe, expect, it } from 'vitest';
import { progressSliderShape } from './progress-slider';

describe('progressSliderShape', () => {
  it('an unknown length renders an empty, unseekable bar (the reproduction)', () => {
    // The pinned-full bug: position 4s into a stream with no known duration
    // used to clamp into a max-1 slider and sit at 100%.
    expect(progressSliderShape(4, null)).toEqual({ max: 1, value: 0, seekable: false });
    expect(progressSliderShape(null, null)).toEqual({ max: 1, value: 0, seekable: false });
  });

  it('a known length fills proportionally and is seekable', () => {
    expect(progressSliderShape(30, 120)).toEqual({ max: 120, value: 30, seekable: true });
    expect(progressSliderShape(null, 120)).toEqual({ max: 120, value: 0, seekable: true });
  });

  it('clamps the value into the track bounds', () => {
    // Queue metadata can be slightly shorter than the asset — never overshoot.
    expect(progressSliderShape(125, 120)).toEqual({ max: 120, value: 120, seekable: true });
    expect(progressSliderShape(-2, 120)).toEqual({ max: 120, value: 0, seekable: true });
  });

  it('a degenerate length the seek funnel would reject is unseekable and empty', () => {
    // Follows resolveSeekTarget's own validation (0s, shorter than the end
    // guard): an enabled slider whose every seek no-ops must never render.
    expect(progressSliderShape(0, 0)).toEqual({ max: 1, value: 0, seekable: false });
  });
});
