// `POST /api/listening/clear-history` → clearListeningHistory.
//
// Removes only the caller's own listening records. Music, generated
// totals and spend accounting are not listening and are left alone.

import { NextResponse } from 'next/server';
import { clearListeningHistory } from '@liedmotif/db';
import { clearListeningHistoryRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const body = await parseJsonBody(
    request,
    clearListeningHistoryRequestSchema,
    'Invalid clear-history request.',
  );
  if (body instanceof NextResponse) return body;

  await clearListeningHistory(getDb(), { ownerUserId });
  return apiOk({ cleared: true as const });
}
