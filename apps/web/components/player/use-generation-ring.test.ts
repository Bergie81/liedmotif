// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGenerationRing } from './use-generation-ring';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NO_TRACKS: string[] = [];

interface RingProps {
  ahead: number;
  tracks?: string[];
}

function ring(initialAhead: number, initialTracks: string[] = NO_TRACKS) {
  const initialProps: RingProps = { ahead: initialAhead, tracks: initialTracks };
  return renderHook(
    ({ ahead, tracks = NO_TRACKS }: RingProps) => useGenerationRing(ahead, tracks),
    {
      initialProps,
    },
  );
}

describe('the ring around a generating run', () => {
  it('stays away while nothing is generating', () => {
    expect(ring(0).result.current.shown).toBe(false);
  });

  it('starts as a sliver so a run with nothing landed still shows it has begun', () => {
    const { result } = ring(2);
    expect(result.current.shown).toBe(true);
    expect(result.current.fraction).toBeCloseTo(0.06);
  });

  it('grows with each Track that lands', () => {
    const { result, rerender } = ring(2);
    rerender({ ahead: 1 });
    expect(result.current.fraction).toBeCloseTo(0.5);
  });

  it('holds the completed ring briefly, then leaves', () => {
    const { result, rerender } = ring(2);
    rerender({ ahead: 1 });
    rerender({ ahead: 0 });
    expect(result.current).toEqual({ shown: true, fraction: 1 });

    act(() => vi.advanceTimersByTime(899));
    expect(result.current.shown).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.shown).toBe(false);
  });

  it('counts Tracks that landed while a refill kept the count level', () => {
    const { result, rerender } = ring(2, ['a']);
    rerender({ ahead: 2, tracks: ['a', 'b', 'c'] });
    expect(result.current.fraction).toBeCloseTo(0.5);
  });

  it('does not count older Tracks the Queue window brings back', () => {
    const { result, rerender } = ring(2, ['b', 'c']);
    rerender({ ahead: 2, tracks: ['a', 'b', 'c'] });
    expect(result.current.fraction).toBeCloseTo(0.06);
  });

  it('widens the run when more Tracks join it', () => {
    const { result, rerender } = ring(2);
    rerender({ ahead: 1 });
    rerender({ ahead: 3 });
    expect(result.current.fraction).toBeCloseTo(0.25);
  });

  it('starts a fresh run after the last one ended', () => {
    const { result, rerender } = ring(2);
    rerender({ ahead: 0 });
    act(() => vi.advanceTimersByTime(900));
    rerender({ ahead: 2 });
    expect(result.current).toEqual({ shown: true, fraction: expect.closeTo(0.06) });
  });

  it('starts a fresh run when Tracks are ordered during the completed hold', () => {
    const { result, rerender } = ring(2);
    rerender({ ahead: 0 });
    act(() => vi.advanceTimersByTime(300));
    rerender({ ahead: 2 });
    expect(result.current.fraction).toBeCloseTo(0.06);

    act(() => vi.advanceTimersByTime(900));
    expect(result.current.shown).toBe(true);
  });
});
