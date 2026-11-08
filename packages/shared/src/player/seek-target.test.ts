import { describe, expect, it } from 'vitest';
import { resolveSeekTarget, SEEK_END_GUARD_SECONDS } from './seek-target';

// The single seek-target decision: every seek
// source funnels through it, so nothing negative, non-finite, or
// beyond-duration can reach `currentTime`, Web Audio, or the nonnegative
// report schema — and with an unknown duration seeking is disabled entirely.

describe('resolveSeekTarget', () => {
  it('passes a target inside [0, duration − guard] through unchanged', () => {
    expect(resolveSeekTarget(42.5, 180)).toBe(42.5);
    expect(resolveSeekTarget(0, 180)).toBe(0);
    expect(resolveSeekTarget(180 - SEEK_END_GUARD_SECONDS, 180)).toBe(180 - SEEK_END_GUARD_SECONDS);
  });

  it('clamps a negative target to 0', () => {
    expect(resolveSeekTarget(-5, 180)).toBe(0);
  });

  it('clamps a beyond-duration target to duration − guard (the seek commit never fires a synchronous end)', () => {
    expect(resolveSeekTarget(180, 180)).toBeCloseTo(180 - SEEK_END_GUARD_SECONDS, 10);
    expect(resolveSeekTarget(9999, 180)).toBeCloseTo(180 - SEEK_END_GUARD_SECONDS, 10);
  });

  it('rejects non-finite raw input (a Media Session seekTime is UA-supplied and untrusted)', () => {
    expect(resolveSeekTarget(Number.NaN, 180)).toBeNull();
    expect(resolveSeekTarget(Number.POSITIVE_INFINITY, 180)).toBeNull();
    expect(resolveSeekTarget(Number.NEGATIVE_INFINITY, 180)).toBeNull();
  });

  it('rejects an unknown or non-finite duration (seeking disabled without a clamp target)', () => {
    expect(resolveSeekTarget(10, null)).toBeNull();
    expect(resolveSeekTarget(10, Number.NaN)).toBeNull();
    expect(resolveSeekTarget(10, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('rejects a zero or shorter-than-guard duration (never an empty or inverted clamp interval)', () => {
    expect(resolveSeekTarget(0, 0)).toBeNull();
    expect(resolveSeekTarget(0, SEEK_END_GUARD_SECONDS)).toBeNull();
    expect(resolveSeekTarget(0, SEEK_END_GUARD_SECONDS / 2)).toBeNull();
    expect(resolveSeekTarget(0, -30)).toBeNull();
  });
});
