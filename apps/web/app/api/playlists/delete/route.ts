// `POST /api/playlists/delete` → deletePlaylist. Memberships go with the
// playlist; members with no other playlist return to Ephemeral (retention is
// membership — the UI confirm names that count first via `soleMemberTrackCount`).
// Favorites refuses (409). Owner-scoped (404 for cross-owner — no IDOR).

import { NextResponse } from 'next/server';
import { deletePlaylist } from '@liedmotif/db';
import { deletePlaylistRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(
    request,
    deletePlaylistRequestSchema,
    'Invalid delete request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const result = await deletePlaylist(getDb(), { ownerUserId, playlistId: parsed.playlistId });
  if (result === null) return apiError('not_found', 'Playlist not found.');
  if (result === 'system') {
    return apiError('conflict', 'Favorites cannot be deleted.');
  }
  return apiOk({ playlistId: parsed.playlistId, deleted: true as const });
}
