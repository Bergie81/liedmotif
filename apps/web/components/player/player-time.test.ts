// The progress display's time formatting:
// unknown values render the explicit unknown form — never a misleading 0:00.

import { describe, expect, it } from 'vitest';
import { formatPlayerTime } from './player-time';

describe('formatPlayerTime', () => {
  it('renders the unknown form for null and unusable input', () => {
    expect(formatPlayerTime(null)).toBe('–:––');
    expect(formatPlayerTime(Number.NaN)).toBe('–:––');
    expect(formatPlayerTime(Number.POSITIVE_INFINITY)).toBe('–:––');
    expect(formatPlayerTime(-1)).toBe('–:––');
  });

  it('formats sub-hour times as m:ss', () => {
    expect(formatPlayerTime(0)).toBe('0:00');
    expect(formatPlayerTime(5.9)).toBe('0:05');
    expect(formatPlayerTime(65)).toBe('1:05');
    expect(formatPlayerTime(600)).toBe('10:00');
    expect(formatPlayerTime(3599)).toBe('59:59');
  });

  it('formats hour-long times as h:mm:ss', () => {
    expect(formatPlayerTime(3600)).toBe('1:00:00');
    expect(formatPlayerTime(3661)).toBe('1:01:01');
    expect(formatPlayerTime(7325)).toBe('2:02:05');
  });
});
