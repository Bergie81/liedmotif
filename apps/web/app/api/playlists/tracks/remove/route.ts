// `POST /api/playlists/tracks/remove` → removePlaylistTrack. Removal from the
// track's LAST playlist returns it to Ephemeral (retention is membership);
// removal from Favorites unfavorites. Removing a non-member is a no-op.

import { NextResponse } from 'next/server';
import { removePlaylistTrack } from '@liedmotif/db';
import { removePlaylistTrackRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(
    request,
    removePlaylistTrackRequestSchema,
    'Invalid remove-track request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const result = await removePlaylistTrack(getDb(), {
    ownerUserId,
    playlistId: parsed.playlistId,
    trackId: parsed.trackId,
  });
  if (!result) return apiError('not_found', 'Playlist not found.');
  return apiOk({
    playlistId: parsed.playlistId,
    trackId: parsed.trackId,
    removed: result.removed,
    unsaved: result.unsaved,
  });
}
