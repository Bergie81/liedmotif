// `POST /api/playlists/tracks/add` → addPlaylistTracks. The multi-select add:
// appends in request order, idempotent per track (no duplicates), membership
// implies Save. Rejected/deleted/foreign tracks come back in `refused` rather
// than failing the whole batch.

import { NextResponse } from 'next/server';
import { addPlaylistTracks } from '@liedmotif/db';
import { addPlaylistTracksRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(
    request,
    addPlaylistTracksRequestSchema,
    'Invalid add-tracks request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const result = await addPlaylistTracks(getDb(), {
    ownerUserId,
    playlistId: parsed.playlistId,
    trackIds: parsed.trackIds,
  });
  if (!result) return apiError('not_found', 'Playlist not found.');
  return apiOk({ playlistId: parsed.playlistId, added: result.added, refused: result.refused });
}
