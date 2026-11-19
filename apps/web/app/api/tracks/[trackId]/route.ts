// `GET /api/tracks/[trackId]` → a single owned track's summary (flags + app-routed
// audio). A small owner-scoped read (NOT one of the 16 registry contracts — the
// library/queue already embed track summaries); kept minimal. A cross-owner or
// malformed id is indistinguishable from a missing one (404 — no IDOR). Audio is
// ALWAYS a same-origin `/api/audio/<id>` path.

import { NextResponse } from 'next/server';
import { getOwnedTrackSummary } from '@liedmotif/db';
import { uuidSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, requireOwnerId } from '@/lib/http/api-response';
import { toTrackSummary } from '@/lib/library/tracks';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ trackId: string }> }) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const { trackId } = await params;
  // A malformed id never reaches the DB (a bad uuid would throw) — treat as not found.
  if (!uuidSchema.safeParse(trackId).success) return apiError('not_found', 'Track not found.');

  const track = await getOwnedTrackSummary(getDb(), { ownerUserId, trackId });
  if (!track) return apiError('not_found', 'Track not found.');
  return apiOk(toTrackSummary(track));
}
