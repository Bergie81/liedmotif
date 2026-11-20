// `POST /api/sessions/try-again` → tryAgainSession.
//
// Try again on an Active Session that has nothing to play: the listener's
// consent to one more paid batch. Recorded as a listener restart, then the
// buffer controller is woken; the worker's tick decides and spends under every
// limit, so this route itself never submits.

import { NextResponse } from 'next/server';
import { tryAgainSession } from '@liedmotif/db';
import { tryAgainSessionRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/http/api-response';
import { enqueueEnsureSessionBuffer } from '@/lib/worker-jobs';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(
    request,
    tryAgainSessionRequestSchema,
    'Invalid Try Again request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const db = getDb();
  const result = await tryAgainSession(db, { ownerUserId, sessionId: parsed.sessionId });
  if (!result.ok) {
    if (result.reason === 'not_found') return apiError('not_found', 'Session not found.');
    return apiError('conflict', 'Only an active session can try again.');
  }

  await enqueueEnsureSessionBuffer(db, parsed.sessionId);
  return apiOk({ id: parsed.sessionId });
}
