import { describe, expect, it } from 'vitest';
import {
  BACKUP_HOUR_OPTIONS,
  backUpNowButton,
  backupsPollMs,
  formatBackupTime,
} from './backups-form-model';

describe('backup schedule form', () => {
  it('offers every hour of the day, on the hour', () => {
    expect(BACKUP_HOUR_OPTIONS).toHaveLength(24);
    expect(BACKUP_HOUR_OPTIONS[0]).toEqual({ value: 0, label: '00:00' });
    expect(BACKUP_HOUR_OPTIONS[3]).toEqual({ value: 3, label: '03:00' });
    expect(BACKUP_HOUR_OPTIONS[23]).toEqual({ value: 23, label: '23:00' });
  });
});

describe('Back up now', () => {
  it('is pressable whenever no backup is under way, even with the sidecar down', () => {
    for (const service of ['healthy', 'overdue', 'failing', 'not-running'] as const) {
      expect(backUpNowButton({ service, submitting: false })).toEqual({
        disabled: false,
        label: 'Back Up Now',
      });
    }
  });

  it('is disabled while the request is sent, once it is requested, and while a backup runs', () => {
    expect(backUpNowButton({ service: 'healthy', submitting: true })).toEqual({
      disabled: true,
      label: 'Requesting…',
    });
    expect(backUpNowButton({ service: 'requested', submitting: false })).toEqual({
      disabled: true,
      label: 'Requested',
    });
    expect(backUpNowButton({ service: 'running', submitting: false })).toEqual({
      disabled: true,
      label: 'Backing Up…',
    });
  });
});

describe('page refresh', () => {
  it('polls every 5 s only while a backup is requested or running', () => {
    expect(backupsPollMs('requested')).toBe(5_000);
    expect(backupsPollMs('running')).toBe(5_000);
    for (const service of ['healthy', 'overdue', 'failing', 'not-running'] as const) {
      expect(backupsPollMs(service)).toBeNull();
    }
  });
});

describe('backup times', () => {
  it('reads in the instance timezone, not the browser’s', () => {
    expect(formatBackupTime('2026-07-05T01:00:00Z', 'Europe/Berlin')).toBe(
      'Sun, 5 Jul 2026, 03:00',
    );
    expect(formatBackupTime('2026-07-05T01:00:00Z', 'America/New_York')).toBe(
      'Sat, 4 Jul 2026, 21:00',
    );
  });
});
