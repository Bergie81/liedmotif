import { describe, expect, it } from 'vitest';
import { sleepTimerNote } from './sleep-timer';

const MINUTE = 60_000;

describe('Sleep Timer note', () => {
  it('names no time while no timer is set', () => {
    expect(sleepTimerNote(null, 0)).toBeUndefined();
  });

  it('counts whole minutes left, rounding up', () => {
    expect(sleepTimerNote(30 * MINUTE, 0)).toBe('30 min left');
    expect(sleepTimerNote(22 * MINUTE + 1, 0)).toBe('23 min left');
  });

  it('never reads zero while the music is still fading out', () => {
    expect(sleepTimerNote(1_000, 0)).toBe('1 min left');
    expect(sleepTimerNote(1_000, 2_000)).toBe('1 min left');
  });
});
