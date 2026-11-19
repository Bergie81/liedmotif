// POST /api/playlists/cover/delete — remove one cover from the Playlist's OWN
// history (a settled generated attempt or an uploaded cover). The bytes are
// reclaimed via the deletion queue; a generated attempt's ledger row (spend
// accounting, provenance) is untouched. The current cover is never deletable —
// select another one (or the mosaic) first.

import { NextResponse } from 'next/server';
import { deletePlaylistCoverFromHistory, getPlaylistCoverSubject } from '@liedmotif/db';
import { deletePlaylistCoverRequestSchema } from '@liedmotif/shared';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/http/api-response';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  const parsed = await parseJsonBody(
    request,
    deletePlaylistCoverRequestSchema,
    'Invalid cover deletion request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const db = getDb();
  const playlist = await getPlaylistCoverSubject(db, {
    ownerUserId,
    playlistId: parsed.playlistId,
  });
  if (!playlist) return apiError('not_found', 'Playlist not found.');

  const result = await deletePlaylistCoverFromHistory(db, {
    ownerUserId,
    playlistId: playlist.id,
    coverImageId: parsed.coverImageId,
  });
  if (result === 'not_found') {
    return apiError('not_found', 'This cover is not part of the Playlist’s cover history.');
  }
  if (result === 'current_cover') {
    return apiError('conflict', 'The current cover cannot be deleted. Select another one first.');
  }
  return apiOk({ coverImageId: parsed.coverImageId });
}
