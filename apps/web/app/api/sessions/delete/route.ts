// `POST /api/sessions/delete` → deleteSession (My Sessions "Delete").
//
// Permanently removes a STOPPED session — row, queue items, playback events — and
// reclaims its Ephemeral tracks' audio in the same transaction (deleting a session
// is the one flow that reclaims its unsaved audio). Saved/
// Favorited tracks stay in the Library, and generation requests / provider jobs
// survive with the session edge set null so spend counting never changes. An
// `active` session (Stop first) is refused with `conflict`. One with in-flight
// provider or cover work succeeds as a deferred delete: it disappears now and the
// worker finishes the delete once that work settles.

import { NextResponse } from 'next/server';
import { deleteSession } from '@liedmotif/db';
import { deleteSessionRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(
    request,
    deleteSessionRequestSchema,
    'Invalid Delete Session request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const result = await deleteSession(getDb(), { ownerUserId, sessionId: parsed.sessionId });
  if (!result.ok) {
    if (result.reason === 'not_found') return apiError('not_found', 'Session not found.');
    return apiError('conflict', 'Stop the session before deleting it.');
  }
  return apiOk({ id: result.id });
}
