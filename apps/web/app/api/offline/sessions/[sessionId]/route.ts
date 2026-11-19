// `GET /api/offline/sessions/[sessionId]` → the offline manifest of one owned
// Session: the Tracks this device may keep Available offline — Download's
// eligibility, so only ready, un-Disliked Tracks with a stored local final — in
// play order, each with its byte size and metadata version. A foreign, absent,
// deleted or malformed id is one uniform 404, the audio route's posture; the
// device then drops its mark.

import { NextResponse } from 'next/server';
import { getOwnedSessionOfflineManifest } from '@liedmotif/db';
import { uuidSchema, type OfflineManifest } from '@liedmotif/shared';
import { apiError, apiOk, requireOwnerId } from '@/lib/http/api-response';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const { sessionId } = await params;
  if (!uuidSchema.safeParse(sessionId).success) {
    return apiError('not_found', 'Session not found.');
  }
  const manifest = await getOwnedSessionOfflineManifest(getDb(), { ownerUserId, sessionId });
  if (!manifest) return apiError('not_found', 'Session not found.');
  return apiOk<OfflineManifest>(manifest);
}
