import { describe, expect, it } from 'vitest';
import { maskSecret } from './masking';

describe('maskSecret', () => {
  it('reveals only the last 4 characters of a long secret', () => {
    expect(maskSecret('sk-1234567890abcdef')).toBe('••••cdef');
  });

  it('fully masks short secrets without leaking their length', () => {
    expect(maskSecret('abcd')).toBe('••••');
    expect(maskSecret('ab')).toBe('••••');
  });

  it('returns an empty string for an empty secret', () => {
    expect(maskSecret('')).toBe('');
  });

  it('never returns more than the masked suffix (no full secret)', () => {
    const masked = maskSecret('super-secret-value-1234');
    expect(masked).toBe('••••1234');
    expect(masked).not.toContain('super');
  });
});
