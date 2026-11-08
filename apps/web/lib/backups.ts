// Instance backups for the web process (server-only). The backup sidecar does
// the work and reports it in files on the backups volume, which the web app
// mounts read-only at `BACKUP_DIR`: `status.json` at the root and a
// `manifest.json` in each complete `liedmotif-backup-<stamp>/` folder. Without
// `BACKUP_DIR` (local `npm run dev`) there is nothing to read, and the page
// shows the sidecar as not running instead of failing.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getBackupRequest, getBackupSchedule, getUsageLimits, type Database } from '@liedmotif/db';
import {
  backupManifestSchema,
  backupStatusFileSchema,
  createLogger,
  type BackupListItem,
  type BackupsOverview,
  type BackupStatusFile,
} from '@liedmotif/shared';
import { getBackupPassphrase } from './backup-download';
import { backupServiceState } from './backup-status-model';

const logger = createLogger({ name: 'backups' });

/** A complete backup folder. In-progress runs write `.partial-<stamp>/`, which never matches. */
export const BACKUP_ID_PATTERN = /^liedmotif-backup-\d{8}T\d{6}Z$/;

export function getBackupDir(): string | null {
  return process.env.BACKUP_DIR?.trim() || null;
}

/**
 * One of the sidecar's JSON files, or null when it is absent, unreadable or
 * the wrong shape. `label` names it in the log and is never a full path.
 */
async function readSidecarFile<T>(
  path: string,
  schema: { safeParse(data: unknown): { success: true; data: T } | { success: false } },
  label: string,
): Promise<T | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('backup file could not be read', { file: label });
    }
    return null;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    logger.warn('backup file has an unexpected shape', { file: label });
    return null;
  }
  return parsed.data;
}

/** The sidecar's last `status.json`, or null when it never wrote one. */
export async function readBackupStatus(dir: string | null): Promise<BackupStatusFile | null> {
  if (!dir) return null;
  return readSidecarFile(join(dir, 'status.json'), backupStatusFileSchema, 'status.json');
}

/** Every complete backup folder with a readable manifest, newest first. */
export async function listBackups(dir: string | null): Promise<BackupListItem[]> {
  if (!dir) return [];
  let ids: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    ids = entries
      .filter((e) => e.isDirectory() && BACKUP_ID_PATTERN.test(e.name))
      .map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('backup folder could not be listed');
    }
    return [];
  }

  const items = await Promise.all(
    ids.map(async (id): Promise<BackupListItem | null> => {
      const label = `${id}/manifest.json`;
      const parsed = await readSidecarFile(join(dir, label), backupManifestSchema, label);
      if (!parsed) return null;
      const { format: _format, mediaSkipped, ...manifest } = parsed;
      return { id, ...manifest, mediaSkipped: mediaSkipped ?? null };
    }),
  );
  // The folder stamp is UTC `yyyymmddThhmmssZ`, so name order is time order.
  return items
    .filter((item): item is BackupListItem => item !== null)
    .sort((a, b) => (a.id < b.id ? 1 : -1));
}

/** Everything the Backups page shows. */
export async function readBackupsOverview(db: Database, nowMs: number): Promise<BackupsOverview> {
  const dir = getBackupDir();
  const [schedule, request, limits, status, backups] = await Promise.all([
    getBackupSchedule(db),
    getBackupRequest(db),
    getUsageLimits(db),
    readBackupStatus(dir),
    listBackups(dir),
  ]);
  const requestedAt = request?.requestedAt ?? null;
  return {
    schedule,
    timezone: limits.resetTimezone,
    service: backupServiceState({ status, requestedAt, nowMs }),
    requestedAt,
    status,
    downloadAvailable: getBackupPassphrase() !== null,
    backups,
  };
}
