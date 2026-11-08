// `POST /api/playlists/memberships/apply` → applyTrackMemberships. The save
// picker's atomic commit: the track's FULL desired membership set (checked
// boxes), an optional inline new playlist, and the derived retention flags in
// one transaction — an empty set is Unsave. A rejected/deleted track refuses
// (409); cross-owner ids read as absent (404 — no IDOR).

import { NextResponse } from 'next/server';
import { applyTrackMemberships } from '@liedmotif/db';
import { applyTrackMembershipsRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';
import { toTrackFlags } from '@/lib/tracks';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(
    request,
    applyTrackMembershipsRequestSchema,
    'Invalid memberships request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const result = await applyTrackMemberships(getDb(), {
    ownerUserId,
    trackId: parsed.trackId,
    playlistIds: parsed.playlistIds,
    createPlaylistName: parsed.createPlaylistName ?? undefined,
  });
  if (result === null) return apiError('not_found', 'Track not found.');
  if (result === 'removed') {
    return apiError('conflict', 'This track was removed and can no longer be saved.');
  }

  return apiOk({
    trackId: parsed.trackId,
    playlistIds: result.playlistIds,
    createdPlaylistId: result.createdPlaylistId,
    flags: toTrackFlags(result.flags),
    inCuratedPlaylist: result.inCuratedPlaylist,
  });
}
