// `POST /api/tracks/rename` → renameTrack.
//
// Replace one Track title with a Given Name (one-way, cosmetic, never
// feedback — the retention class and Sibling Tracks are untouched). The title
// tag of the downloaded file follows in the background: the enqueue is
// unconditional (like the lyrics backfill) because the embed job itself no-ops
// for a track without a local MP3, is idempotent via its tag-state marker, and
// never touches the storage key — that keeps the slug captured at download time.

import { NextResponse } from 'next/server';
import { renameTrackRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';
import { giveTrackName } from '@/lib/given-names';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(request, renameTrackRequestSchema, 'Invalid rename request.');
  if (parsed instanceof NextResponse) return parsed;

  const renamed = await giveTrackName(getDb(), {
    ownerUserId,
    trackId: parsed.trackId,
    title: parsed.title,
  });
  if (!renamed) return apiError('not_found', 'Track not found.');
  return apiOk(renamed);
}
