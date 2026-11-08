import { describe, expect, it } from 'vitest';
import { sessionDurationLabel, isSessionDurationReached } from './session-duration-model';
describe('Session duration progress', () => {
  it('shows exact generated progress and whole-batch overshoot', () => {
    expect(sessionDurationLabel({ targetDurationMinutes: 20, generatedDurationSeconds: 720 })).toBe(
      '12 / 20 min generated',
    );
    expect(
      sessionDurationLabel({ targetDurationMinutes: 20, generatedDurationSeconds: 1320 }),
    ).toBe('22 / 20 min · Repeating');
    expect(
      isSessionDurationReached({ targetDurationMinutes: 20, generatedDurationSeconds: 1199 }),
    ).toBe(false);
  });
  it('never presents unknown totals as exact or completed', () => {
    expect(
      sessionDurationLabel({
        targetDurationMinutes: 20,
        generatedDurationSeconds: 720,
        unknownDurationTrackCount: 1,
      }),
    ).toBe('12+ / 20 min · Duration unknown');
    expect(sessionDurationLabel({})).toBeNull();
  });
});
