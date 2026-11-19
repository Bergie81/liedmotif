// `POST /api/sessions/resume` → resumeSession.
//
// Re-activates a Stopped session under its SAME identity (stored Style Snapshot +
// queue position), stops the current active session (`endReason='superseded'`), sets
// `lastResumedAt`, and resets `generationStatus` to `ok`. NEVER gated by cost limits —
// Resume falls back to the session's own surviving material — so there
// is no headroom check here.

import { NextResponse } from 'next/server';
import { resumeSession } from '@liedmotif/db';
import { resumeSessionRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/http/api-response';
import { toSessionSummary } from '@/lib/sessions/sessions';
import { enqueueEnsureSessionBuffer } from '@/lib/worker-jobs';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(
    request,
    resumeSessionRequestSchema,
    'Invalid Resume Session request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const db = getDb();
  const result = await resumeSession(db, { ownerUserId, sessionId: parsed.sessionId });
  if (!result.ok) {
    if (result.reason === 'not_found') return apiError('not_found', 'Session not found.');
    return apiError('conflict', 'Only a stopped session can be resumed.');
  }

  // Kick the buffer so a resumed session's first top-up (when its mode and
  // headroom allow — the worker's controller decides all of that) does not
  // wait for the once-per-minute sweep. Best-effort, same job key as the sweep.
  await enqueueEnsureSessionBuffer(db, result.session.id);

  return apiOk({
    session: toSessionSummary(result.session),
    supersededSessionId: result.supersededSessionId,
  });
}
