// `GET /api/lounge/playlist` → getLoungePlaylistDetail: one
// playlist in the Visitor's Lounge, attributed to its owner, members
// keyset-paged on position like the owner's detail read. Unknown, private,
// revoked, and outside-the-audience ids answer the uniform 404. Audio is
// ALWAYS a same-origin `/api/audio/<id>` path; the audio route
// itself composes the same Lounge-audible predicate.

import { NextResponse } from 'next/server';
import { getPlaylistRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, requireOwnerId, validateInput } from '@/lib/api-response';
import { loadLoungePlaylistDetailPage } from '@/lib/lounge';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const viewerUserId = await requireOwnerId(request);
  if (viewerUserId instanceof NextResponse) return viewerUserId;

  const url = new URL(request.url);
  const parsed = validateInput(
    getPlaylistRequestSchema,
    {
      playlistId: url.searchParams.get('playlistId') ?? undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
    },
    'Invalid playlist request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const detail = await loadLoungePlaylistDetailPage(getDb(), viewerUserId, {
    playlistId: parsed.playlistId,
    cursor: parsed.cursor ?? null,
    limit: parsed.limit,
  });
  if (!detail) return apiError('not_found', 'Playlist not found.');
  return apiOk(detail);
}
