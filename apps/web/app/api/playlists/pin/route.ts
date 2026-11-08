// `POST /api/playlists/pin` → setPlaylistLibraryPinned: put
// an own playlist first in the caller's Playlists tab, or take it back out.
// Idempotent both ways, and independent of the Lounge's Pin (`/api/lounge/pin`).
// The refusal is uniform: another owner's playlist, an unknown id, and a system
// playlist all answer the same 404.

import { NextResponse } from 'next/server';
import { setPlaylistLibraryPinned } from '@liedmotif/db';
import { pinPlaylistRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(request, pinPlaylistRequestSchema, 'Invalid pin request.');
  if (parsed instanceof NextResponse) return parsed;

  const result = await setPlaylistLibraryPinned(getDb(), { ownerUserId, ...parsed });
  if (result === 'not_found') return apiError('not_found', 'Playlist not found.');
  return apiOk({ playlistId: parsed.playlistId, pinned: parsed.pinned });
}
