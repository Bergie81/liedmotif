// Admin-only: Settings → Backups. The schedule lives in `app_settings`; the
// status and the backup list come from the sidecar's files (`lib/backups.ts`).
// A backup holds every account's content, so no part of this is Member-visible.

import { NextResponse } from 'next/server';
import { updateBackupSchedule } from '@liedmotif/db';
import { backupScheduleSchema } from '@liedmotif/shared';
import { apiOk, parseJsonBody, requireAdminOwnerId } from '@/lib/api-response';
import { readBackupsOverview } from '@/lib/backups';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const admin = await requireAdminOwnerId(request);
  if (admin instanceof NextResponse) return admin;
  return apiOk(await readBackupsOverview(getDb(), Date.now()));
}

/** The whole schedule, as the page's form holds it. */
export async function PUT(request: Request) {
  const admin = await requireAdminOwnerId(request);
  if (admin instanceof NextResponse) return admin;

  const schedule = await parseJsonBody(request, backupScheduleSchema, 'Invalid backup schedule.');
  if (schedule instanceof NextResponse) return schedule;

  return apiOk({ schedule: await updateBackupSchedule(getDb(), schedule) });
}
