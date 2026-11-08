import { describe, expect, it } from 'vitest';
import { MAX_USER_PROMPT_LENGTH } from '@liedmotif/shared';
import {
  PROMPT_EXAMPLES,
  TYPE_TOTAL_FRAMES,
  nextTypedFrame,
  pickExampleIndex,
  typedFrame,
} from './prompt-examples';

describe('the example pool', () => {
  it('is non-empty and contains no blank entries', () => {
    expect(PROMPT_EXAMPLES.length).toBeGreaterThan(0);
    for (const example of PROMPT_EXAMPLES) {
      expect(example.trim()).not.toBe('');
    }
  });

  it('keeps every entry within the maximum user-prompt length', () => {
    for (const example of PROMPT_EXAMPLES) {
      expect(example.length).toBeLessThanOrEqual(MAX_USER_PROMPT_LENGTH);
    }
  });

  it('contains no duplicates', () => {
    expect(new Set(PROMPT_EXAMPLES).size).toBe(PROMPT_EXAMPLES.length);
  });

  it('retains the multi-line briefings with their line breaks intact', () => {
    const briefings = PROMPT_EXAMPLES.filter((example) => example.includes('\n'));
    expect(briefings.length).toBeGreaterThanOrEqual(6);
    const wedding = PROMPT_EXAMPLES.find((example) => example.includes('wedding song'));
    expect(wedding).toContain('\n\n- They met at university');
  });
});

describe('pickExampleIndex', () => {
  const randomOf = (value: number) => () => value;

  it('returns a valid in-range index across the random range, including boundaries', () => {
    for (const value of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const index = pickExampleIndex(PROMPT_EXAMPLES, null, randomOf(value));
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(PROMPT_EXAMPLES.length);
      expect(Number.isInteger(index)).toBe(true);
    }
  });

  it('never returns the excluded last-shown index when the pool has more than one entry', () => {
    const pool = ['a', 'b', 'c', 'd'];
    for (let last = 0; last < pool.length; last++) {
      for (const value of [0, 0.33, 0.66, 0.999999]) {
        expect(pickExampleIndex(pool, last, randomOf(value))).not.toBe(last);
      }
    }
  });

  it('returns the only index when the pool has exactly one entry', () => {
    expect(pickExampleIndex(['only'], 0, randomOf(0.9))).toBe(0);
    expect(pickExampleIndex(['only'], null, randomOf(0))).toBe(0);
  });

  it('handles an absent or out-of-range last-shown index without throwing', () => {
    const pool = ['a', 'b', 'c'];
    for (const last of [null, -1, 3, 99, Number.NaN, 1.5]) {
      const index = pickExampleIndex(pool, last, randomOf(0.999999));
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(pool.length);
    }
  });
});

describe('typedFrame', () => {
  const briefing = PROMPT_EXAMPLES.find((example) => example.includes('\n'))!;
  const short = PROMPT_EXAMPLES.find((example) => !example.includes('\n'))!;

  it('produces the empty string at frame zero and the exact target at the final frame', () => {
    expect(typedFrame(short, 0)).toBe('');
    expect(typedFrame(briefing, 0)).toBe('');
    expect(typedFrame(short, TYPE_TOTAL_FRAMES)).toBe(short);
    expect(typedFrame(briefing, TYPE_TOTAL_FRAMES)).toBe(briefing);
  });

  it('returns a genuine prefix of the target at every frame', () => {
    for (const target of [short, briefing]) {
      for (let frame = 0; frame <= TYPE_TOTAL_FRAMES; frame++) {
        expect(target.startsWith(typedFrame(target, frame))).toBe(true);
      }
    }
  });

  it('never shrinks the visible text from one frame to the next', () => {
    for (const target of [short, briefing]) {
      let previous = 0;
      for (let frame = 0; frame <= TYPE_TOTAL_FRAMES; frame++) {
        const length = typedFrame(target, frame).length;
        expect(length).toBeGreaterThanOrEqual(previous);
        previous = length;
      }
    }
  });

  it('completes a short and a long example within the same frame count', () => {
    expect(typedFrame(short, TYPE_TOTAL_FRAMES - 1)).not.toBe(short);
    expect(typedFrame(briefing, TYPE_TOTAL_FRAMES - 1)).not.toBe(briefing);
    expect(typedFrame(short, TYPE_TOTAL_FRAMES)).toBe(short);
    expect(typedFrame(briefing, TYPE_TOTAL_FRAMES)).toBe(briefing);
  });
});

describe('nextTypedFrame', () => {
  it('advances one frame at a time and terminates at the final frame', () => {
    let frame: number | null = 0;
    let steps = 0;
    while (frame != null) {
      const next: number | null = nextTypedFrame(frame);
      if (next != null) expect(next).toBe(frame + 1);
      frame = next;
      steps += 1;
    }
    expect(steps).toBe(TYPE_TOTAL_FRAMES + 1);
  });
});
