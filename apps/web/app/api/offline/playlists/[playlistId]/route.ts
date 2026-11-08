// `GET /api/offline/playlists/[playlistId]` → the offline manifest of one
// Playlist the viewer may hear — their own (Favorites included) or one in their
// Lounge: the members this device may keep Available offline — a Track the
// viewer can hear with a stored local final, the audio route's own scope — in
// position order, each with its byte size and metadata version. Another
// owner's Private Playlist, a revoked or narrowed share, an absent or a
// malformed id is one uniform 404, the audio route's posture; the device then
// drops its mark and the Tracks no other mark lists.

import { NextResponse } from 'next/server';
import { getReadablePlaylistOfflineManifest } from '@liedmotif/db';
import { uuidSchema, type OfflineManifest } from '@liedmotif/shared';
import { apiError, apiOk, requireOwnerId } from '@/lib/api-response';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ playlistId: string }> },
): Promise<Response> {
  const viewerUserId = await requireOwnerId(request);
  if (viewerUserId instanceof NextResponse) return viewerUserId;

  const { playlistId } = await params;
  if (!uuidSchema.safeParse(playlistId).success) {
    return apiError('not_found', 'Playlist not found.');
  }
  const manifest = await getReadablePlaylistOfflineManifest(getDb(), { viewerUserId, playlistId });
  if (!manifest) return apiError('not_found', 'Playlist not found.');
  return apiOk<OfflineManifest>(manifest);
}
