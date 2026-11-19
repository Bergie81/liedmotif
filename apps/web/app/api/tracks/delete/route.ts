import { NextResponse } from 'next/server';
import { deleteTrack } from '@liedmotif/db';
import { deleteTrackRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/http/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(request, deleteTrackRequestSchema, 'Invalid delete request.');
  if (parsed instanceof NextResponse) return parsed;

  const result = await deleteTrack(getDb(), { ownerUserId, trackId: parsed.trackId });
  if (!result) return apiError('not_found', 'Track not found.');
  return apiOk({ trackId: parsed.trackId, deleted: true as const });
}
