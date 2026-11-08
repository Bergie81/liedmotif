// `/api/playlists/share`. POST → setPlaylistShared: place
// an owned playlist In Lounge for an audience (`everyone` or `selected`
// Users), change who it reaches, or return it to Private (`audience` null).
// GET → getPlaylistShare: the share picker's read — the current audience and
// every other User as a candidate. Curated user playlists only —
// Favorites and unlisted collections refuse (409); a `selected` audience naming
// no valid User refuses (400). Owner-scoped: a cross-owner playlistId is
// indistinguishable from a missing one (404 — no IDOR).

import { NextResponse } from 'next/server';
import { getPlaylistShare, setPlaylistShared } from '@liedmotif/db';
import { getPlaylistShareRequestSchema, sharePlaylistRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId, validateInput } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const url = new URL(request.url);
  const parsed = validateInput(
    getPlaylistShareRequestSchema,
    { playlistId: url.searchParams.get('playlistId') ?? undefined },
    'Invalid share request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const share = await getPlaylistShare(getDb(), {
    ownerUserId,
    playlistId: parsed.playlistId,
  });
  if (!share) return apiError('not_found', 'Playlist not found.');
  return apiOk({ playlistId: parsed.playlistId, ...share });
}

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(request, sharePlaylistRequestSchema, 'Invalid share request.');
  if (parsed instanceof NextResponse) return parsed;

  const result = await setPlaylistShared(getDb(), {
    ownerUserId,
    playlistId: parsed.playlistId,
    audience: parsed.audience,
  });
  if (result === null) return apiError('not_found', 'Playlist not found.');
  if (result === 'system') {
    return apiError('conflict', 'This playlist cannot be shared to the Lounge.');
  }
  if (result === 'empty_audience') {
    return apiError('validation_error', 'Pick at least one person to share with.');
  }
  return apiOk({
    playlistId: parsed.playlistId,
    sharedAt: result.sharedAt ? result.sharedAt.toISOString() : null,
    audience: result.audience,
  });
}
