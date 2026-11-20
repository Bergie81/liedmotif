// POST /api/playlists/cover/select — re-point the Playlist at a cover from its
// OWN history (a settled generated attempt or an uploaded cover), or clear it
// back to the derived member-cover mosaic with null. Zero cost: no
// provider call, no limit consumption — only the pointer swap.

import { NextResponse } from 'next/server';
import {
  findCoverInPlaylistHistory,
  getPlaylistCoverSubject,
  setPlaylistCoverImage,
} from '@liedmotif/db';
import { selectPlaylistCoverRequestSchema } from '@liedmotif/shared';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/http/api-response';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  const parsed = await parseJsonBody(
    request,
    selectPlaylistCoverRequestSchema,
    'Invalid cover selection request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const db = getDb();
  const playlist = await getPlaylistCoverSubject(db, {
    ownerUserId,
    playlistId: parsed.playlistId,
  });
  if (!playlist) return apiError('not_found', 'Playlist not found.');

  if (parsed.coverImageId !== null) {
    const entry = await findCoverInPlaylistHistory(db, {
      ownerUserId,
      playlistId: playlist.id,
      coverImageId: parsed.coverImageId,
    });
    if (!entry) {
      return apiError('not_found', 'This cover is not part of the playlist’s cover history.');
    }
  }

  await setPlaylistCoverImage(db, {
    ownerUserId,
    playlistId: playlist.id,
    coverImageId: parsed.coverImageId,
  });
  return apiOk({ coverImageId: parsed.coverImageId });
}
