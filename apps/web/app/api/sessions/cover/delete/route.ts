// POST /api/sessions/cover/delete — remove one cover, generated or uploaded,
// from the Session's OWN history. The bytes are reclaimed via the deletion
// queue; a generation ledger row (spend accounting, provenance) is untouched.
// The current cover is never deletable — re-select another one first.

import { NextResponse } from 'next/server';
import { deleteSessionCoverFromHistory, getSessionById } from '@liedmotif/db';
import { deleteSessionCoverRequestSchema } from '@liedmotif/shared';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/http/api-response';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  const parsed = await parseJsonBody(
    request,
    deleteSessionCoverRequestSchema,
    'Invalid cover deletion request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const db = getDb();
  const session = await getSessionById(db, { ownerUserId, sessionId: parsed.activitySessionId });
  if (!session) return apiError('not_found', 'Session not found.');

  const result = await deleteSessionCoverFromHistory(db, {
    ownerUserId,
    activitySessionId: session.id,
    coverImageId: parsed.coverImageId,
  });
  if (result === 'not_found') {
    return apiError('not_found', 'This cover is not part of the session’s cover history.');
  }
  if (result === 'current_cover') {
    return apiError('conflict', 'The current cover cannot be deleted. Select another one first.');
  }
  return apiOk({ coverImageId: parsed.coverImageId });
}
