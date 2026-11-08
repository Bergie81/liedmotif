// POST /api/sessions/cover/select — re-point the Session at a cover from its
// OWN history, generated or uploaded (explicit user replacement). Zero cost:
// no provider call, no limit consumption — only the pointer swap plus track
// metadata retagging.

import { NextResponse } from 'next/server';
import {
  findCoverInSessionHistory,
  getSessionById,
  listFinalMp3TrackIdsForSession,
  setSessionCoverImage,
} from '@liedmotif/db';
import { selectSessionCoverRequestSchema } from '@liedmotif/shared';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';
import { getDb } from '@/lib/db';
import { enqueueEmbedTrackMetadataBatch } from '@/lib/worker-jobs';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  const parsed = await parseJsonBody(
    request,
    selectSessionCoverRequestSchema,
    'Invalid cover selection request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const db = getDb();
  const session = await getSessionById(db, { ownerUserId, sessionId: parsed.activitySessionId });
  if (!session) return apiError('not_found', 'Session not found.');
  const entry = await findCoverInSessionHistory(db, {
    ownerUserId,
    activitySessionId: session.id,
    coverImageId: parsed.coverImageId,
  });
  if (!entry) {
    return apiError('not_found', 'This cover is not part of the Session’s cover history.');
  }

  await setSessionCoverImage(db, {
    ownerUserId,
    sessionId: session.id,
    coverImageId: parsed.coverImageId,
  });
  const trackIds = await listFinalMp3TrackIdsForSession(db, session.id);
  await enqueueEmbedTrackMetadataBatch(db, trackIds);
  return apiOk({ coverImageId: parsed.coverImageId });
}
