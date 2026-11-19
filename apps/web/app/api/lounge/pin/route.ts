// `POST /api/lounge/pin` → setPlaylistLoungePinned: put a playlist
// that is in the caller's Lounge, their own shares included, first in that
// Lounge, or take it back out. Idempotent both ways, and independent of the
// Library pin (`/api/playlists/pin`). The refusal is uniform: a Private playlist
// and an unknown id answer the same 404, so a pin attempt can never probe what
// privately exists.

import { NextResponse } from 'next/server';
import { setPlaylistLoungePinned } from '@liedmotif/db';
import { pinPlaylistRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/http/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const viewerUserId = await requireOwnerId(request);
  if (viewerUserId instanceof NextResponse) return viewerUserId;

  const parsed = await parseJsonBody(request, pinPlaylistRequestSchema, 'Invalid pin request.');
  if (parsed instanceof NextResponse) return parsed;

  const result = await setPlaylistLoungePinned(getDb(), {
    viewerUserId,
    playlistId: parsed.playlistId,
    pinned: parsed.pinned,
  });
  if (result === null) return apiError('not_found', 'Playlist not found.');
  return apiOk({ playlistId: parsed.playlistId, pinned: result.pinned });
}
