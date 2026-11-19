// `POST /api/feedback` → sendFeedback. The general AUDIT write behind the listener
// loop — its only live caller is the Skip soft-negative. It is
// AUDIT-ONLY: it appends a `feedback_events` row and NEVER mutates track flags or feeds
// generation/steering — the dedicated save/favorite/dislike routes own the flags. No
// `like` type exists. Owner-scoped: the trackId (and sessionId, if present) MUST belong
// to the caller or the write is rejected (no IDOR).

import { NextResponse } from 'next/server';
import { getOwnedTrackSummary, getSessionById, recordFeedbackEvent } from '@liedmotif/db';
import { sendFeedbackRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/http/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(request, sendFeedbackRequestSchema, 'Invalid feedback.');
  if (parsed instanceof NextResponse) return parsed;
  const { trackId, sessionId, type, value, freeformText } = parsed;

  const db = getDb();

  // Owner-scope the references BEFORE any write so a cross-owner trackId/sessionId
  // (IDOR) is rejected with no audit row written.
  const ownedTrack = await getOwnedTrackSummary(db, { ownerUserId, trackId });
  if (!ownedTrack) return apiError('not_found', 'Track not found.');
  if (sessionId) {
    const session = await getSessionById(db, { ownerUserId, sessionId });
    if (!session) return apiError('not_found', 'Session not found.');
  }

  const { id } = await recordFeedbackEvent(db, {
    userId: ownerUserId,
    trackId,
    activitySessionId: sessionId,
    feedbackType: type,
    value,
    freeformText,
  });
  return apiOk({ recorded: true as const, feedbackEventId: id });
}
