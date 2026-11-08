// `POST /api/sessions/stop` → stopSession.
//
// Owns the `endReason='user_stopped'` write (the repo records it on the active→stopped
// move). Idempotent: stopping an already-stopped session is a no-op that keeps its
// prior end reason. In-flight provider tasks may still arrive and count toward limits.

import { NextResponse } from 'next/server';
import { stopSession } from '@liedmotif/db';
import { stopSessionRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(
    request,
    stopSessionRequestSchema,
    'Invalid Stop Session request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const result = await stopSession(getDb(), { ownerUserId, sessionId: parsed.sessionId });
  if (!result) return apiError('not_found', 'Session not found.');
  return apiOk(result);
}
