// Settings → Backups: what the schedule form offers, when Back up now can be
// pressed, and how the sidecar's state reads. Pure, so the rules are tested
// without rendering the page.

import type {
  BackupError,
  BackupListItem,
  BackupServiceState,
  BackupsOverview,
} from '@liedmotif/shared';
import { formatBinaryBytes } from '@/lib/format-bytes';
import type { SettingsStatus } from '@/lib/settings/settings-hub-model';

/** Slots fall on the hour, in the instance timezone. */
export const BACKUP_HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => ({
  value: hour,
  label: `${String(hour).padStart(2, '0')}:00`,
}));

/**
 * A second request during a run would start another backup right after it, and
 * a pending request already runs on the sidecar's next check. A down sidecar
 * still takes the request: it runs once the sidecar is back.
 */
export function backUpNowButton(input: { service: BackupServiceState; submitting: boolean }): {
  disabled: boolean;
  label: string;
} {
  if (input.submitting) return { disabled: true, label: 'Requesting…' };
  if (input.service === 'running') return { disabled: true, label: 'Backing up…' };
  if (input.service === 'requested') return { disabled: true, label: 'Requested' };
  return { disabled: false, label: 'Back up now' };
}

/**
 * While a backup is requested or running the page follows it closely; otherwise
 * nothing changes faster than the sidecar's minute check, and the page refreshes
 * when it regains focus instead.
 */
export function backupsPollMs(service: BackupServiceState): number | null {
  return service === 'requested' || service === 'running' ? 5_000 : null;
}

/**
 * Slots are cut in the instance timezone, so every time on the page reads in it;
 * pinning the zone also keeps the server and client renders equal.
 */
export function formatBackupTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: timezone,
  }).format(new Date(iso));
}

const ERROR_TEXT: Record<BackupError, string> = {
  'dump-failed': 'the database dump failed',
  'media-failed': 'copying music and covers failed',
  'low-disk': 'the backups disk is nearly full',
  'database-unreachable': 'the database could not be reached',
};

/** The state badge and the sentence under it. */
export function backupStatusSummary(
  overview: Pick<BackupsOverview, 'service' | 'schedule' | 'timezone' | 'status'>,
): { status: SettingsStatus; detail: string } {
  const at = (iso: string) => formatBackupTime(iso, overview.timezone);
  const report = overview.status;
  switch (overview.service) {
    case 'not-running':
      return {
        status: { label: 'Not running', tone: 'warn' },
        detail: report
          ? `The backup service last checked in ${at(report.checkedAt)}. No backup runs until it is back.`
          : 'The backup service has never reported. It is the backup container in Docker Compose; no backup runs without it.',
      };
    case 'running':
      return {
        status: { label: 'Running', tone: 'ok' },
        detail: report?.running
          ? `A ${report.running.trigger === 'manual' ? 'manual' : 'scheduled'} backup started ${at(report.running.startedAt)}.`
          : 'A backup is running.',
      };
    case 'requested':
      return {
        status: { label: 'Requested', tone: 'muted' },
        detail: 'Back up now was pressed. The backup starts within a minute.',
      };
    case 'failing': {
      const error = report?.lastAttempt?.error;
      const reason = error ? ERROR_TEXT[error] : 'an unknown error';
      const retry = report?.retryAt ? ` Next try ${at(report.retryAt)}.` : '';
      return {
        status: { label: 'Failing', tone: 'warn' },
        detail: `The last backup failed: ${reason}.${retry}`,
      };
    }
    case 'overdue':
      return {
        status: { label: 'Overdue', tone: 'warn' },
        detail: 'A scheduled backup is due and has not run yet.',
      };
    case 'healthy':
      return {
        status: { label: 'Healthy', tone: 'ok' },
        detail: overview.schedule.enabled
          ? 'Backups run on schedule.'
          : 'Scheduled backups are off. Back up now still works.',
      };
  }
}

/**
 * The sidecar reports whether it encrypts; before it ever reported, the web
 * server's own passphrase is the best guess, since both read the same `.env`.
 */
export function backupsUnencrypted(
  overview: Pick<BackupsOverview, 'status' | 'downloadAvailable'>,
): boolean {
  return overview.status ? !overview.status.encrypted : !overview.downloadAvailable;
}

/** The second line of a list row: trigger, size and what it holds. */
export function backupListMeta(backup: BackupListItem): string {
  const trigger = backup.trigger === 'manual' ? 'Manual' : 'Scheduled';
  const size = formatBinaryBytes(backup.dbBytes + backup.mediaBytes);
  let contents = 'Database only';
  if (backup.includesMedia) contents = 'Music & covers';
  else if (backup.mediaSkipped === 'object-storage') contents = 'Database only · object storage';
  return `${trigger} · ${size} · ${contents}`;
}
