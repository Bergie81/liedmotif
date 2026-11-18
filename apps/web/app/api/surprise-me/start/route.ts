// `POST /api/surprise-me/start` → start the previewed Surprise Me proposal
//
// The request names a proposal; the Style Snapshot it starts is the one stored
// server-side at preview time, so no text LLM runs and the client
// never supplies style or lyric direction. Answers like `POST /api/sessions`.

import { NextResponse } from 'next/server';
import { startSurpriseRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, apiRateLimited, parseJsonBody, requireOwnerId } from '@/lib/api-response';
import { toSessionSummary } from '@/lib/sessions';
import { startSurprise } from '@/lib/surprise-me';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const body = await parseJsonBody(
    request,
    startSurpriseRequestSchema,
    'Invalid Surprise Me request.',
  );
  if (body instanceof NextResponse) return body;

  const result = await startSurprise(getDb(), { ownerUserId, ...body });
  if (result.ok) {
    return apiOk({
      session: toSessionSummary(result.session),
      supersededSessionId: result.supersededSessionId,
    });
  }
  switch (result.reason) {
    case 'refused':
      return apiError(result.code, result.message);
    case 'not_pending':
      return apiError('conflict', result.message);
    case 'rate_limited':
      return apiRateLimited(result.retryAfterMs);
  }
}
