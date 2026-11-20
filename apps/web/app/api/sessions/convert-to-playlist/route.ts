// `POST /api/sessions/convert-to-playlist` → convertSessionToPlaylist.
//
// Files a Session's listed Tracks into a new Playlist named after it, which makes
// them Durable. The Session stays as it is, whether Stopped or Active. Generates
// nothing and spends nothing.

import { NextResponse } from 'next/server';
import { convertSessionToPlaylist } from '@liedmotif/db';
import { convertSessionToPlaylistRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/http/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(
    request,
    convertSessionToPlaylistRequestSchema,
    'Invalid convert-to-playlist request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const result = await convertSessionToPlaylist(getDb(), {
    ownerUserId,
    sessionId: parsed.sessionId,
  });
  if (!result.ok) {
    return result.reason === 'not_found'
      ? apiError('not_found', 'Session not found.')
      : apiError('validation_error', 'This session has no tracks yet.');
  }
  return apiOk({ playlistId: result.playlistId, trackCount: result.trackCount });
}
