// `POST /api/playlists/tracks/order` → setPlaylistOrder. Replaces the whole
// playlist order in one write: the reorder mode buffers drags locally and
// commits once, so a half-applied order is never reachable. An order that is no
// longer the playlist's membership is a conflict, not a clamp — the client
// reloads rather than guessing what the owner meant.

import { NextResponse } from 'next/server';
import { setPlaylistOrder } from '@liedmotif/db';
import { setPlaylistOrderRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/http/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(request, setPlaylistOrderRequestSchema, 'Invalid order.');
  if (parsed instanceof NextResponse) return parsed;

  const result = await setPlaylistOrder(getDb(), {
    ownerUserId,
    playlistId: parsed.playlistId,
    trackIds: parsed.trackIds,
  });
  if (!result) return apiError('not_found', 'Playlist not found.');
  if (result === 'stale') {
    return apiError('conflict', 'This playlist changed — reload it and reorder again.');
  }
  return apiOk({ playlistId: parsed.playlistId, trackIds: result.trackIds });
}
