// Instance backups: the Admin's schedule (`backupSchedule`) and the Back up now
// request (`backupRequest`), both stored in `app_settings`. The backup sidecar
// reads them through `docker/backup-due.sql`, which repeats these defaults for
// an absent key; the two must stay equal. Slots are cut in the instance
// timezone, `usageLimits.resetTimezone`, so there is no timezone field here.

import { z } from 'zod';
import { isoDatetimeSchema } from './common';

export const BACKUP_FREQUENCIES = ['daily', 'weekly'] as const;
export type BackupFrequency = (typeof BACKUP_FREQUENCIES)[number];

/** How many complete backups rotation keeps: a year of weekly ones at most. */
export const BACKUP_KEEP_MIN = 1;
export const BACKUP_KEEP_MAX = 52;

/**
 * - `weekday`: 0 = Sunday … 6 = Saturday; read only when `frequency` is weekly.
 * - `hour`: the local hour of the slot, on the hour.
 * - `includeMedia`: snapshot `/data` beside the dump (skipped on object storage).
 */
export const backupScheduleSchema = z.strictObject({
  enabled: z.boolean(),
  frequency: z.enum(BACKUP_FREQUENCIES),
  weekday: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  keep: z.number().int().min(BACKUP_KEEP_MIN).max(BACKUP_KEEP_MAX),
  includeMedia: z.boolean(),
});
export type BackupSchedule = z.infer<typeof backupScheduleSchema>;

export const DEFAULT_BACKUP_SCHEDULE: BackupSchedule = {
  enabled: true,
  frequency: 'weekly',
  weekday: 0,
  hour: 3,
  keep: 4,
  includeMedia: true,
};

/** Written by Back up now; the sidecar runs once for a request newer than its last attempt. */
export interface BackupRequest {
  /** ISO-8601 timestamp. */
  requestedAt: string;
}

// The two files the sidecar writes on the backups volume, which the web app
// mounts read-only: `status.json` at its root and one `manifest.json` per
// backup folder. Unknown keys are ignored so the sidecar can add fields first.

export const BACKUP_TRIGGERS = ['schedule', 'manual'] as const;

/** Why an attempt failed: a fixed vocabulary, never raw command output. */
export const BACKUP_ERRORS = [
  'dump-failed',
  'media-failed',
  'low-disk',
  'database-unreachable',
] as const;
export type BackupError = (typeof BACKUP_ERRORS)[number];

/**
 * `status.json`, rewritten every minute. `checkedAt` is the sidecar's liveness
 * signal; `nextRunAt` is the next scheduled slot (null while the schedule is off).
 */
export const backupStatusFileSchema = z.object({
  checkedAt: isoDatetimeSchema,
  nextRunAt: isoDatetimeSchema.nullable(),
  running: z
    .object({
      startedAt: isoDatetimeSchema,
      trigger: z.enum(BACKUP_TRIGGERS),
    })
    .nullable(),
  lastAttempt: z
    .object({
      startedAt: isoDatetimeSchema,
      finishedAt: isoDatetimeSchema,
      ok: z.boolean(),
      error: z.enum(BACKUP_ERRORS).optional(),
    })
    .nullable(),
  lastSuccessAt: isoDatetimeSchema.nullable(),
  /**
   * The schedule is on and the last success predates the last scheduled slot,
   * measured against the slots `docker/backup-due.sql` cuts in the instance
   * timezone.
   */
  overdue: z.boolean(),
  retryAt: isoDatetimeSchema.nullish(),
  /** The whole backups volume, each hardlinked file counted once. */
  diskBytes: z.number().nonnegative(),
  freeBytes: z.number().nonnegative(),
  /** Whether the sidecar encrypts dumps (a passphrase is configured). */
  encrypted: z.boolean(),
});
export type BackupStatusFile = z.infer<typeof backupStatusFileSchema>;

/** `manifest.json` inside one complete `liedmotif-backup-<stamp>/` folder. */
export const backupManifestSchema = z.object({
  format: z.literal(1),
  createdAt: isoDatetimeSchema,
  trigger: z.enum(BACKUP_TRIGGERS),
  encrypted: z.boolean(),
  includesMedia: z.boolean(),
  mediaSkipped: z.literal('object-storage').optional(),
  dbBytes: z.number().nonnegative(),
  mediaBytes: z.number().nonnegative(),
  mediaFiles: z.number().int().nonnegative(),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

/**
 * What the Backups page shows about the sidecar, in precedence order:
 * - `not-running`: no `status.json`, or its `checkedAt` is stale.
 * - `running`: a backup is in progress.
 * - `requested`: Back up now was pressed and the run has not started yet.
 * - `failing`: the last attempt failed (see its `error` and `retryAt`).
 * - `overdue`: the schedule is on and the last success predates the last slot.
 * - `healthy`: none of the above.
 */
export type BackupServiceState =
  'not-running' | 'running' | 'requested' | 'failing' | 'overdue' | 'healthy';

/** One complete backup folder, as the list shows it. */
export interface BackupListItem extends Omit<BackupManifest, 'format' | 'mediaSkipped'> {
  /** The folder name, `liedmotif-backup-<yyyymmdd>T<hhmmss>Z`. */
  id: string;
  mediaSkipped: 'object-storage' | null;
}

/** `GET /api/settings/backups`. */
export interface BackupsOverview {
  schedule: BackupSchedule;
  /** The instance timezone (`usageLimits.resetTimezone`) the slots are cut in. */
  timezone: string;
  service: BackupServiceState;
  requestedAt: string | null;
  /** The sidecar's last `status.json`, even when stale; null when it never wrote one. */
  status: BackupStatusFile | null;
  /**
   * Whether the web server holds `BACKUP_ENCRYPTION_PASSPHRASE`. The download is
   * encrypted with it, so without one there is no download.
   */
  downloadAvailable: boolean;
  /** Newest first. */
  backups: BackupListItem[];
}
