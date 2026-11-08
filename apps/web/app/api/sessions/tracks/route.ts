import { NextResponse } from 'next/server';
import { listSessionTracks } from '@liedmotif/db';
import { listSessionTracksRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import {
  apiError,
  apiOk,
  requireOwnerId,
  validateInput,
  validateKeysetCursor,
} from '@/lib/api-response';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  const params = new URL(request.url).searchParams;
  const parsed = validateInput(
    listSessionTracksRequestSchema,
    {
      sessionId: params.get('sessionId'),
      cursor: params.get('cursor'),
      limit: params.get('limit') ?? undefined,
    },
    'Invalid Session tracks request.',
  );
  if (parsed instanceof NextResponse) return parsed;
  const cursor = validateKeysetCursor(parsed.cursor, 'Invalid Session tracks cursor.');
  if (cursor instanceof NextResponse) return cursor;
  const result = await listSessionTracks(getDb(), { ...parsed, cursor, ownerUserId });
  return result ? apiOk(result) : apiError('not_found', 'Session not found.');
}
