// `POST /api/sessions/pin` → setSessionPinned.
//
// Pin or unpin a Session. Pinning past the
// per-owner cap is refused with `limit_reached`.

import { NextResponse } from 'next/server';
import { setSessionPinned } from '@liedmotif/db';
import { SESSION_PIN_LIMIT_MESSAGE, setSessionPinnedRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(
    request,
    setSessionPinnedRequestSchema,
    'Invalid pin request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const result = await setSessionPinned(getDb(), { ownerUserId, ...parsed });
  if (result === 'not_found') return apiError('not_found', 'Session not found.');
  if (result === 'limit_reached') {
    return apiError('limit_reached', SESSION_PIN_LIMIT_MESSAGE);
  }
  return apiOk({ id: parsed.sessionId, pinned: parsed.pinned });
}
