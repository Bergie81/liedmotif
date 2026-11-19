// `POST /api/lounge/moderate` → moderateLoungePlaylistToPrivate:
// the Admin's single cross-owner write — return a playlist in the Admin's own
// Lounge to Private through the owner's own unshare chokepoint, so the full
// revocation purge (Shared references and Pins) fires identically.
// Admin-gated; a Private id, one shared with selected Users that exclude the
// Admin, and an unknown id all answer the same 404, so even the Admin can
// never probe what is hidden from them.

import { NextResponse } from 'next/server';
import { moderateLoungePlaylistToPrivate } from '@liedmotif/db';
import { moderateLoungePlaylistRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireAdminOwnerId } from '@/lib/http/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const adminUserId = await requireAdminOwnerId(request);
  if (adminUserId instanceof NextResponse) return adminUserId;

  const parsed = await parseJsonBody(
    request,
    moderateLoungePlaylistRequestSchema,
    'Invalid moderation request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const result = await moderateLoungePlaylistToPrivate(getDb(), {
    adminUserId,
    playlistId: parsed.playlistId,
  });
  if (result === null) return apiError('not_found', 'Playlist not found.');
  return apiOk({ playlistId: parsed.playlistId });
}
