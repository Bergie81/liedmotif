// `GET /api/library` → getLibrary. The owner's track-centric library for one view
// (Saved / Favorites / History), cursor-paged. SESSION-centric My Sessions lives at
// `GET /api/sessions` — this is the distinct track-centric list ("play or keep this
// song"). Strictly owner-scoped: only the caller's own tracks are returned. Audio is
// ALWAYS a same-origin `/api/audio/<id>` path.

import { NextResponse } from 'next/server';
import { getLibraryTracks } from '@liedmotif/db';
import { getLibraryRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiOk, requireOwnerId, validateInput, validateKeysetCursor } from '@/lib/api-response';
import { toLibraryTrackItem } from '@/lib/tracks';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const url = new URL(request.url);
  const parsed = validateInput(
    getLibraryRequestSchema,
    {
      view: url.searchParams.get('view') ?? undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      search: url.searchParams.get('search') ?? undefined,
    },
    'Invalid library request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const cursor = validateKeysetCursor(parsed.cursor, 'Invalid library cursor.');
  if (cursor instanceof NextResponse) return cursor;

  const { items, nextCursor } = await getLibraryTracks(getDb(), {
    ownerUserId,
    view: parsed.view,
    cursor,
    limit: parsed.limit,
    search: parsed.search ?? null,
  });

  return apiOk({ view: parsed.view, items: items.map(toLibraryTrackItem), nextCursor });
}
