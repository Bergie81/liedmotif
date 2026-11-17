// `POST /api/sessions/rename` → renameSession.
//
// Replace the Session Name with a Given Name (one-way, cosmetic,
// never steering — nothing in the system writes over it afterwards). Embedded
// file tags follow the rename: every downloaded track in the session retags its
// album tag in the background (best-effort, deduped per track, idempotent via
// the embed job's tag-state marker); storage keys and the Session Cover stay
// untouched.

import { NextResponse } from 'next/server';
import { renameSessionRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';
import { giveSessionName } from '@/lib/given-names';
import { toSessionSummary } from '@/lib/sessions';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(
    request,
    renameSessionRequestSchema,
    'Invalid rename request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const session = await giveSessionName(getDb(), {
    ownerUserId,
    sessionId: parsed.sessionId,
    title: parsed.title,
  });
  if (!session) return apiError('not_found', 'Session not found.');
  return apiOk({ session: toSessionSummary(session) });
}
