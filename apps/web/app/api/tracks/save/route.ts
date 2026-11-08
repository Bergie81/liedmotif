// `POST /api/tracks/save` — the UNSAVE-ALL path (retention is playlist
// membership): `saved: false` removes the track from every playlist
// and returns it to Ephemeral. Saving means choosing at least one Playlist,
// which the picker commits atomically through
// `/api/playlists/memberships/apply` — so the schema pins `saved` to the
// literal false. Owner-scoped: a cross-owner trackId is indistinguishable from
// a missing one (404 — no IDOR); a rejected/deleted track refuses the write
// (409).

import { NextResponse } from 'next/server';
import { unsaveTrackEverywhere } from '@liedmotif/db';
import { saveTrackRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';
import { toTrackFlags } from '@/lib/tracks';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(request, saveTrackRequestSchema, 'Invalid save request.');
  if (parsed instanceof NextResponse) return parsed;

  const flags = await unsaveTrackEverywhere(getDb(), {
    ownerUserId,
    trackId: parsed.trackId,
  });
  if (!flags) return apiError('not_found', 'Track not found.');
  if (flags === 'removed') {
    return apiError('conflict', 'This track was removed and can no longer be updated.');
  }
  return apiOk(toTrackFlags(flags));
}
