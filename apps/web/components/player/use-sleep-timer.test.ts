// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSleepTimer, type SleepTimerTarget } from './use-sleep-timer';

const MINUTE = 60_000;

function fakePlayer() {
  const volumes: number[] = [];
  const player: SleepTimerTarget & { volumes: number[]; paused: number } = {
    volumes,
    paused: 0,
    setOutputVolume: (volume) => volumes.push(volume),
    pause: () => {
      player.paused += 1;
    },
  };
  return player;
}

function mountTimer(players: SleepTimerTarget[]) {
  return renderHook(() => useSleepTimer(() => players));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Sleep Timer', () => {
  it('pauses the music once the chosen time is up', () => {
    const player = fakePlayer();
    const { result } = mountTimer([player]);
    act(() => result.current.start(30));

    act(() => vi.advanceTimersByTime(30 * MINUTE - 1_000));
    expect(player.paused).toBe(0);

    act(() => vi.advanceTimersByTime(1_000));
    expect(player.paused).toBe(1);
    expect(result.current.endsAt).toBeNull();
  });

  it('fades the music out over its last seconds, then restores the level for the next play', () => {
    const player = fakePlayer();
    const { result } = mountTimer([player]);
    act(() => result.current.start(5));

    act(() => vi.advanceTimersByTime(5 * MINUTE - 5_000));
    const midFade = player.volumes.at(-1)!;
    expect(midFade).toBeGreaterThan(0);
    expect(midFade).toBeLessThan(1);
    expect(player.paused).toBe(0);

    act(() => vi.advanceTimersByTime(5_000));
    expect(player.paused).toBe(1);
    expect(player.volumes.at(-1)).toBe(1);
  });

  it('turned off mid-fade, leaves the music playing at full level', () => {
    const player = fakePlayer();
    const { result } = mountTimer([player]);
    act(() => result.current.start(5));
    act(() => vi.advanceTimersByTime(5 * MINUTE - 5_000));

    act(() => result.current.cancel());
    act(() => vi.advanceTimersByTime(10 * MINUTE));
    expect(player.paused).toBe(0);
    expect(player.volumes.at(-1)).toBe(1);
  });

  it('also silences a source that hands in mid-fade', () => {
    const outgoing = fakePlayer();
    const incoming = fakePlayer();
    let audible: SleepTimerTarget[] = [outgoing];
    const { result } = renderHook(() => useSleepTimer(() => audible));
    act(() => result.current.start(5));
    act(() => vi.advanceTimersByTime(5 * MINUTE - 5_000));

    audible = [incoming];
    act(() => vi.advanceTimersByTime(5_000));
    expect(incoming.paused).toBe(1);
    expect(incoming.volumes.at(-1)).toBe(1);
  });

  it('counts a newly chosen time from now, replacing the running one', () => {
    const player = fakePlayer();
    const { result } = mountTimer([player]);
    act(() => result.current.start(10));
    act(() => vi.advanceTimersByTime(8 * MINUTE));

    act(() => result.current.start(5));
    act(() => vi.advanceTimersByTime(5 * MINUTE - 1_000));
    expect(player.paused).toBe(0);
    act(() => vi.advanceTimersByTime(1_000));
    expect(player.paused).toBe(1);
  });
});
