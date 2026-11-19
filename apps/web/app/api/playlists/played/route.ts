// `POST /api/playlists/played` → touchPlaylistPlayed. Stamps the playlist's
// `lastPlayedAt` when playback engages — the "played last" half of the Playlists
// tab's activity order (`updatedAt` covers membership changes). Owner-scoped: a
// cross-owner playlistId reads as absent (404 — no IDOR).

import { NextResponse } from 'next/server';
import { touchPlaylistPlayed } from '@liedmotif/db';
import { markPlaylistPlayedRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/http/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(
    request,
    markPlaylistPlayedRequestSchema,
    'Invalid playlist-played request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const touched = await touchPlaylistPlayed(getDb(), {
    ownerUserId,
    playlistId: parsed.playlistId,
  });
  if (!touched) return apiError('not_found', 'Playlist not found.');
  return apiOk({ playlistId: parsed.playlistId });
}
