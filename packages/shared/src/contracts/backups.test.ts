import { describe, expect, it } from 'vitest';
import { backupScheduleSchema, DEFAULT_BACKUP_SCHEDULE } from './backups';

describe('backup schedule', () => {
  it('defaults to weekly, Sunday 03:00, keep 4, media included', () => {
    expect(DEFAULT_BACKUP_SCHEDULE).toEqual({
      enabled: true,
      frequency: 'weekly',
      weekday: 0,
      hour: 3,
      keep: 4,
      includeMedia: true,
    });
    expect(backupScheduleSchema.parse(DEFAULT_BACKUP_SCHEDULE)).toEqual(DEFAULT_BACKUP_SCHEDULE);
  });

  it('accepts every value at the edges of its range', () => {
    const edges = [
      { weekday: 0, hour: 0, keep: 1 },
      { weekday: 6, hour: 23, keep: 52 },
    ];
    for (const edge of edges) {
      const schedule = { ...DEFAULT_BACKUP_SCHEDULE, frequency: 'daily', ...edge };
      expect(backupScheduleSchema.safeParse(schedule).success).toBe(true);
    }
  });

  it('rejects out-of-range, fractional and unknown values', () => {
    const invalid = [
      { weekday: -1 },
      { weekday: 7 },
      { hour: -1 },
      { hour: 24 },
      { hour: 3.5 },
      { keep: 0 },
      { keep: 53 },
      { frequency: 'monthly' },
      { retentionDays: 30 },
    ];
    for (const change of invalid) {
      expect(
        backupScheduleSchema.safeParse({ ...DEFAULT_BACKUP_SCHEDULE, ...change }).success,
        JSON.stringify(change),
      ).toBe(false);
    }
  });
});
