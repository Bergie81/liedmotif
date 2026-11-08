import { describe, expect, it } from 'vitest';
import {
  SCRAMBLE_GLYPHS,
  SCRAMBLE_TOTAL_FRAMES,
  nextScrambleFrame,
  scrambleFrame,
} from './title-scramble';

describe('scrambleFrame', () => {
  const target = 'NIGHT CIRCUIT';

  it('locks a growing left-to-right prefix of the real title', () => {
    const frame = 8; // halfway: floor(13 * 8 / 16) = 6 characters revealed
    const out = scrambleFrame(target, frame, () => 0);
    expect(out).toHaveLength(target.length);
    expect(out.slice(0, 6)).toBe(target.slice(0, 6));
  });

  it('keeps spaces steady and churns the rest from the glyph set', () => {
    const out = scrambleFrame(target, 1, () => 0.5);
    for (let i = 0; i < target.length; i++) {
      if (target[i] === ' ') {
        expect(out[i]).toBe(' ');
      } else if (i >= Math.floor((target.length * 1) / SCRAMBLE_TOTAL_FRAMES)) {
        expect(SCRAMBLE_GLYPHS).toContain(out[i]!);
      }
    }
  });

  it('renders the clean title on the final frame', () => {
    expect(scrambleFrame(target, SCRAMBLE_TOTAL_FRAMES, () => 0.99)).toBe(target);
  });
});

describe('nextScrambleFrame', () => {
  it('advances frame by frame', () => {
    expect(nextScrambleFrame(1)).toBe(2);
    expect(nextScrambleFrame(SCRAMBLE_TOTAL_FRAMES - 1)).toBe(SCRAMBLE_TOTAL_FRAMES);
  });

  it('terminates after the final frame', () => {
    expect(nextScrambleFrame(SCRAMBLE_TOTAL_FRAMES)).toBeNull();
  });
});
