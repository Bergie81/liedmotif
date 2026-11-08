import { describe, expect, it } from 'vitest';
import {
  NUMERIC_LIMIT_KEYS,
  USAGE_LIMIT_CEILINGS,
  usageLimitFloor,
  type UsageLimitCeilingField,
} from './usage-limit-ceilings';

describe('usage limit floors', () => {
  it('holds concurrency, queue depth and idle auto-stop at 1 or more and every other limit at 0 or more', () => {
    const flooredAtOne: readonly UsageLimitCeilingField[] = [
      'maxConcurrentJobs',
      'maxQueuedTracks',
      'idleAutoStopAfterMinutes',
    ];
    for (const key of flooredAtOne) expect(usageLimitFloor(key), key).toBe(1);
    for (const key of NUMERIC_LIMIT_KEYS.filter((key) => !flooredAtOne.includes(key))) {
      expect(usageLimitFloor(key), key).toBe(0);
    }
  });
});

describe('usage limit ceilings', () => {
  it('keeps the monthly ceilings at or above the daily ones they must exceed', () => {
    // Every budget refuses a monthly cap below its daily one, so a monthly
    // ceiling under the daily one would leave the top of the daily range
    // impossible to pair with any legal monthly value.
    expect(USAGE_LIMIT_CEILINGS.monthlyGenerationTasks).toBeGreaterThanOrEqual(
      USAGE_LIMIT_CEILINGS.dailyGenerationTasks,
    );
    expect(USAGE_LIMIT_CEILINGS.generatedCoversPerMonth).toBeGreaterThanOrEqual(
      USAGE_LIMIT_CEILINGS.generatedCoversPerDay,
    );
  });
});
