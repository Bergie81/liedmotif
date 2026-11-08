// `POST /api/tracks/favorite` → favoriteTrack. A LIBRARY retention action,
// never a steering signal. Favoriting IMPLIES Save (the retention floor); unfavoriting
// does NOT unsave. Owner-scoped (404 for a cross-owner trackId — no IDOR); a
// rejected/deleted track refuses the write (409 — it is leaving the library); the
// flag is the source of truth.

import { NextResponse } from 'next/server';
import { setTrackFavorited } from '@liedmotif/db';
import { favoriteTrackRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';
import { toTrackFlags } from '@/lib/tracks';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(
    request,
    favoriteTrackRequestSchema,
    'Invalid favorite request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const flags = await setTrackFavorited(getDb(), {
    ownerUserId,
    trackId: parsed.trackId,
    favorited: parsed.favorited,
  });
  if (!flags) return apiError('not_found', 'Track not found.');
  if (flags === 'removed') {
    return apiError('conflict', 'This track was removed and can no longer be updated.');
  }
  return apiOk(toTrackFlags(flags));
}
