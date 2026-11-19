// `GET /api/diagnostics` → getDiagnostics (owner-scoped, SAFE status only).
//
// Serves the owner's active session + usage (counted in tasks, shown in TRACKS)
// for the home view's "what's playing" bootstrap, plus the worker
// status object `/settings/diagnostics` renders (heartbeat, queue counts,
// provider activity, sanitized events — see `lib/admin/worker-diagnostics`). The
// per-provider validation list is NOT wired here yet and stays an empty
// placeholder. NOTHING here leaks a provider key, signed URL, or raw provider
// error.

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { apiOk, requireAdminOwnerId } from '@/lib/http/api-response';
import { loadAppChrome } from '@/lib/app-chrome';
import { getWorkerDiagnostics } from '@/lib/admin/worker-diagnostics';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ownerUserId = await requireAdminOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const db = getDb();
  const [chrome, worker] = await Promise.all([
    loadAppChrome(db, ownerUserId),
    getWorkerDiagnostics(db),
  ]);

  return apiOk({ worker, providers: [], ...chrome });
}
