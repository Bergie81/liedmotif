// Unauthenticated email confirm via the one-shot link mailed to the address.
// Same posture as the reset endpoint: throttled per IP, one opaque refusal for
// every kind of dead link, tokens never logged. The confirm page posts here
// from a button, so a mail scanner prefetching the link never spends it.

import { NextResponse } from 'next/server';
import { confirmEmailWithToken } from '@liedmotif/db';
import { confirmEmailRequestSchema } from '@liedmotif/shared';
import {
  apiError,
  apiOk,
  apiRateLimited,
  parseJsonBody,
  refuseCrossOrigin,
} from '@/lib/http/api-response';
import { INVALID_LINK_MESSAGE } from '@/lib/constants';
import { getDb } from '@/lib/db';
import { clientIp } from '@/lib/http/http';
import { linkTokenLimiter } from '@/lib/http/request-limits';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const crossOrigin = refuseCrossOrigin(request);
  if (crossOrigin) return crossOrigin;

  const limit = linkTokenLimiter.check(clientIp(request));
  if (!limit.allowed) return apiRateLimited(limit.retryAfterMs);

  const body = await parseJsonBody(request, confirmEmailRequestSchema, INVALID_LINK_MESSAGE);
  if (body instanceof NextResponse) return body;

  const result = await confirmEmailWithToken(getDb(), { token: body.token });
  if (!result.ok) return apiError('not_found', INVALID_LINK_MESSAGE);
  return apiOk({});
}
