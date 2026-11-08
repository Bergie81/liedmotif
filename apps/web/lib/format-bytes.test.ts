import { describe, expect, it } from 'vitest';
import { formatBinaryBytes } from './format-bytes';

describe('formatBinaryBytes', () => {
  it('uses one binary-unit policy for every Settings surface', () => {
    expect(formatBinaryBytes(0)).toBe('0 B');
    expect(formatBinaryBytes(1536)).toBe('1.5 KiB');
    expect(formatBinaryBytes(512 * 1024 ** 2)).toBe('512 MiB');
    expect(formatBinaryBytes(10 * 1024 ** 3)).toBe('10 GiB');
  });

  it('rejects invalid and negative measurements', () => {
    expect(formatBinaryBytes(Number.NaN)).toBe('—');
    expect(formatBinaryBytes(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatBinaryBytes(-1)).toBe('—');
  });
});
