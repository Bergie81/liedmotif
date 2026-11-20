// `POST /api/sessions/play-track` → playSessionTrack.
//
// Play one of a session's own Tracks THROUGH the session (the track rows'
// tap-to-play): a Stopped session resumes positioned at that track — the same
// lifecycle move as Resume, superseding the current active session — while an
// Active session only gets its queue cursor moved. Like Resume, never gated by
// cost limits: it plays what the session already has.

import { NextResponse } from 'next/server';
import { playSessionTrack } from '@liedmotif/db';
import { playSessionTrackRequestSchema } from '@liedmotif/shared';
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
    playSessionTrackRequestSchema,
    'Invalid play-track request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const db = getDb();
  const result = await playSessionTrack(db, {
    ownerUserId,
    sessionId: parsed.sessionId,
    trackId: parsed.trackId,
  });
  if (!result.ok) {
    if (result.reason === 'not_found') return apiError('not_found', 'Session not found.');
    return apiError('not_found', 'That track is no longer available in this session.');
  }

  // Same best-effort kick as Resume: a resumed session's first top-up (when
  // its mode and headroom allow — the worker controller decides) should not
  // wait for the once-per-minute sweep.
  await enqueueEnsureSessionBuffer(db, result.session.id);

  return apiOk({
    session: toSessionSummary(result.session),
    supersededSessionId: result.supersededSessionId,
  });
}
