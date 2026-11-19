// `GET /api/lounge` → the Lounge listing: every non-empty
// playlist in the viewer's Lounge — shared with everyone or with them by name,
// across all owners — attributed, newest-shared first, keyset-paged. There is
// no owner scope by design; the share audience is the only filter.

import { NextResponse } from 'next/server';
import { listLoungeRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import {
  apiOk,
  requireOwnerId,
  validateInput,
  validateKeysetCursor,
} from '@/lib/http/api-response';
import { loadLoungePlaylists } from '@/lib/library/lounge';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const viewerUserId = await requireOwnerId(request);
  if (viewerUserId instanceof NextResponse) return viewerUserId;

  const url = new URL(request.url);
  const parsed = validateInput(
    listLoungeRequestSchema,
    {
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      query: url.searchParams.get('query') ?? undefined,
      owner: url.searchParams.get('owner') ?? undefined,
    },
    'Invalid Lounge request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const cursor = validateKeysetCursor(parsed.cursor, 'Invalid Lounge cursor.');
  if (cursor instanceof NextResponse) return cursor;

  const { playlists, nextCursor } = await loadLoungePlaylists(getDb(), viewerUserId, {
    cursor,
    limit: parsed.limit,
    query: parsed.query,
    owner: parsed.owner,
  });
  return apiOk({ playlists, nextCursor });
}
