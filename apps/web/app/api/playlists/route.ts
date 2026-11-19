// `GET /api/playlists` → listPlaylists (Favorites first, then the Library pins;
// with ?trackId= each summary reports `containsTrack` — the picker read).
// `POST /api/playlists` → createPlaylist (an empty user playlist).
// Strictly owner-scoped (retention is playlist membership).

import { NextResponse } from 'next/server';
import { createPlaylist } from '@liedmotif/db';
import { createPlaylistRequestSchema, listPlaylistsRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import {
  apiOk,
  parseJsonBody,
  requireOwnerId,
  validateInput,
  validateKeysetCursor,
} from '@/lib/http/api-response';
import { loadPlaylistSummaries, toPlaylistSummaryItem } from '@/lib/library/playlists';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const url = new URL(request.url);
  const parsed = validateInput(
    listPlaylistsRequestSchema,
    {
      trackId: url.searchParams.get('trackId') ?? undefined,
      search: url.searchParams.get('search') ?? undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
    },
    'Invalid playlists request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const cursor = validateKeysetCursor(parsed.cursor, 'Invalid playlists cursor.');
  if (cursor instanceof NextResponse) return cursor;

  const { playlists, nextCursor } = await loadPlaylistSummaries(getDb(), ownerUserId, {
    containsTrackId: parsed.trackId ?? null,
    search: parsed.search ?? null,
    cursor,
    limit: parsed.limit,
  });
  return apiOk({ playlists, nextCursor });
}

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(
    request,
    createPlaylistRequestSchema,
    'Invalid create-playlist request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const created = await createPlaylist(getDb(), { ownerUserId, name: parsed.name });
  return apiOk({
    playlist: toPlaylistSummaryItem({
      ...created,
      trackCount: 0,
      totalDurationSeconds: 0,
      downloadableTrackCount: 0,
      mosaicCoverImageIds: [],
      soleMemberTrackCount: 0,
      soleMemberDeletedTrackCount: 0,
      containsTrack: null,
    }),
  });
}
