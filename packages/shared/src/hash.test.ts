import { describe, expect, it } from 'vitest';
import { hash32 } from './hash';

describe('hash32', () => {
  it.each([
    ['', 2_166_136_261],
    ['a', 3_826_002_220],
    ['lofi#0', 1_065_536_790],
    ['lofi#1', 1_082_314_409],
    ['Liedmotif 🎵', 1_658_966_589],
  ])('keeps the stable hash for %j', (value, expected) => {
    expect(hash32(value)).toBe(expected);
  });
});
