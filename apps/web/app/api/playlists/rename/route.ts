// `POST /api/playlists/rename` → renamePlaylist. User playlists only — the
// Favorites system playlist has a fixed name (409). Owner-scoped: a cross-owner
// playlistId is indistinguishable from a missing one (404 — no IDOR).

import { NextResponse } from 'next/server';
import { renamePlaylist } from '@liedmotif/db';
import { renamePlaylistRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(
    request,
    renamePlaylistRequestSchema,
    'Invalid rename request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const result = await renamePlaylist(getDb(), {
    ownerUserId,
    playlistId: parsed.playlistId,
    name: parsed.name,
  });
  if (result === null) return apiError('not_found', 'Playlist not found.');
  if (result === 'system') {
    return apiError('conflict', 'Favorites cannot be renamed.');
  }
  return apiOk({ playlistId: parsed.playlistId, name: parsed.name });
}
