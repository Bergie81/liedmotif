// `POST /api/listening/personalization` → setPersonalizeSuggestions.
//
// The caller's own switch for learned taste. Off stops learning and
// its use; listening stats are recorded either way.

import { NextResponse } from 'next/server';
import { setPersonalizeSuggestions } from '@liedmotif/db';
import { setPersonalizationRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiOk, parseJsonBody, requireOwnerId } from '@/lib/http/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const body = await parseJsonBody(
    request,
    setPersonalizationRequestSchema,
    'Invalid personalization request.',
  );
  if (body instanceof NextResponse) return body;

  await setPersonalizeSuggestions(getDb(), { ownerUserId, enabled: body.enabled });
  return apiOk({ enabled: body.enabled });
}
