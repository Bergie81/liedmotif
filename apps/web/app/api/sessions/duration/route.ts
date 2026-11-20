import { NextResponse } from 'next/server';
import { setSessionDuration } from '@liedmotif/db';
import { setSessionDurationRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/http/api-response';
import { toSessionSummary } from '@/lib/sessions/sessions';
import { enqueueEnsureSessionBuffer } from '@/lib/worker-jobs';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  const parsed = await parseJsonBody(
    request,
    setSessionDurationRequestSchema,
    'Choose a whole duration from 1 to 600 minutes, or No Limit.',
  );
  if (parsed instanceof NextResponse) return parsed;
  const db = getDb();
  const session = await setSessionDuration(db, { ownerUserId, ...parsed });
  if (!session) return apiError('not_found', 'Session not found.');
  if (session.status === 'active') await enqueueEnsureSessionBuffer(db, session.id);
  return apiOk({ session: toSessionSummary(session) });
}
