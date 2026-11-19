// `POST /api/listening/reset-taste` → resetLearnedTaste.
//
// Starts the caller's learned taste afresh. Listening history and
// its stats are left alone; Clear listening history is the action that removes both.

import { NextResponse } from 'next/server';
import { resetLearnedTaste } from '@liedmotif/db';
import { resetLearnedTasteRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiOk, parseJsonBody, requireOwnerId } from '@/lib/http/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const body = await parseJsonBody(
    request,
    resetLearnedTasteRequestSchema,
    'Invalid reset-taste request.',
  );
  if (body instanceof NextResponse) return body;

  await resetLearnedTaste(getDb(), { ownerUserId });
  return apiOk({ reset: true as const });
}
