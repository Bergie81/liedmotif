// `POST /api/sessions/mode` → switchSessionMode.
//
// The Session's generation policy, written from user
// intent only: `keep_going` generates new Tracks within the Session's duration
// target (every new Session starts there) and `repeat`
// stops generating and loops the Session's own Tracks at zero cost. The worker
// consumes the policy on its next buffer tick and never writes it; that tick is
// also where a `repeat` Session's pending Dislike-reroll intents are cancelled
// (one cancellation point, not two).

import { NextResponse } from 'next/server';
import { setSessionModeRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/http/api-response';
import { switchSessionMode } from '@/lib/sessions/session-mode';
import { toSessionSummary } from '@/lib/sessions/sessions';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(
    request,
    setSessionModeRequestSchema,
    'Invalid session-mode request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const session = await switchSessionMode(getDb(), {
    ownerUserId,
    sessionId: parsed.sessionId,
    mode: parsed.mode,
  });
  if (!session) return apiError('not_found', 'Session not found.');

  return apiOk({ session: toSessionSummary(session) });
}
