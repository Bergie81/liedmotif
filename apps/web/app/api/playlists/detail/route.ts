// `GET /api/playlists/detail` → getPlaylist. One owned playlist with its
// members in user order, keyset-paged on position. Audio is ALWAYS a
// same-origin `/api/audio/<id>` path.

import { NextResponse } from 'next/server';
import { getPlaylistDetail } from '@liedmotif/db';
import { getPlaylistRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, requireOwnerId, validateInput } from '@/lib/http/api-response';
import { toPlaylistMemberItem, toPlaylistSummaryItem } from '@/lib/library/playlists';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

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

  const detail = await getPlaylistDetail(getDb(), {
    ownerUserId,
    playlistId: parsed.playlistId,
    cursor: parsed.cursor ?? null,
    limit: parsed.limit,
  });
  if (!detail) return apiError('not_found', 'Playlist not found.');

  return apiOk({
    playlist: toPlaylistSummaryItem(detail.playlist),
    items: detail.items.map(toPlaylistMemberItem),
    nextCursor: detail.nextCursor,
  });
}
