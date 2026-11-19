// Admin-only: Back up now. Records the request in `app_settings`; the backup
// sidecar picks it up on its next minute check, with or without a schedule.

import { NextResponse } from 'next/server';
import { requestBackup } from '@liedmotif/db';
import { apiError, apiOk, requireAdminOwnerId } from '@/lib/http/api-response';
import { isBackupRunning } from '@/lib/admin/backup-status-model';
import { getBackupDir, readBackupStatus } from '@/lib/admin/backups';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const admin = await requireAdminOwnerId(request);
  if (admin instanceof NextResponse) return admin;

  // A request made during a run would start a second backup right after it.
  if (isBackupRunning(await readBackupStatus(getBackupDir()), Date.now())) {
    return apiError('conflict', 'A backup is already running.', { retryable: true });
  }

  return apiOk({ request: await requestBackup(getDb()) });
}
