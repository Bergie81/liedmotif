// The backup sidecar's state as the Backups page shows it, derived from its
// `status.json`, the Back up now request and the clock. Pure, so the boundary
// cases are tested without a volume.

import type { BackupServiceState, BackupStatusFile } from '@liedmotif/shared';

/**
 * The sidecar rewrites `checkedAt` every minute, so three missed checks mean it
 * is down; the sidecar's own healthcheck uses the same window.
 */
export const BACKUP_STATUS_STALE_AFTER_MS = 3 * 60_000;

function isAlive(status: BackupStatusFile, nowMs: number): boolean {
  return nowMs - Date.parse(status.checkedAt) <= BACKUP_STATUS_STALE_AFTER_MS;
}

/** A stale `running` is a sidecar that died mid-run, not a backup in progress. */
export function isBackupRunning(status: BackupStatusFile | null, nowMs: number): boolean {
  return status !== null && isAlive(status, nowMs) && status.running !== null;
}

export function backupServiceState(input: {
  status: BackupStatusFile | null;
  requestedAt: string | null;
  nowMs: number;
}): BackupServiceState {
  const { status, requestedAt, nowMs } = input;
  if (!status || !isAlive(status, nowMs)) return 'not-running';
  if (status.running) return 'running';

  // The sidecar's own rule: a request runs when it is newer than the last attempt's start.
  const lastAttemptMs = status.lastAttempt ? Date.parse(status.lastAttempt.startedAt) : -Infinity;
  if (requestedAt && Date.parse(requestedAt) > lastAttemptMs) return 'requested';

  if (status.lastAttempt && !status.lastAttempt.ok) return 'failing';
  if (status.overdue) return 'overdue';
  return 'healthy';
}
