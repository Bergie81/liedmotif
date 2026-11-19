// Unauthenticated password reset via a one-shot link the Admin minted
//. Same posture as the claim endpoint: throttled per IP, one
// opaque refusal for every kind of dead link, tokens never logged.

import { NextResponse } from 'next/server';
import { resetPasswordWithToken } from '@liedmotif/db';
import { resetPasswordRequestSchema } from '@liedmotif/shared';
import {
  apiError,
  apiOk,
  apiRateLimited,
  fieldErrorMessage,
  parseJsonBody,
  refuseCrossOrigin,
} from '@/lib/http/api-response';
import { INVALID_LINK_MESSAGE } from '@/lib/constants';
import { getDb } from '@/lib/db';
import { clientIp } from '@/lib/http/http';
import { linkTokenLimiter } from '@/lib/http/request-limits';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  // No auth guard runs here, so the Origin refusal is the route's own: a forged
  // cross-site post spends the one-shot link and sets a password the victim
  // never chose.
  const crossOrigin = refuseCrossOrigin(request);
  if (crossOrigin) return crossOrigin;

  const limit = linkTokenLimiter.check(clientIp(request));
  if (!limit.allowed) return apiRateLimited(limit.retryAfterMs);

  const body = await parseJsonBody(
    request,
    resetPasswordRequestSchema,
    fieldErrorMessage('password', 'Invalid reset.'),
  );
  if (body instanceof NextResponse) return body;

  const result = await resetPasswordWithToken(getDb(), {
    token: body.token,
    newPassword: body.password,
  });
  if (!result.ok) return apiError('not_found', INVALID_LINK_MESSAGE);
  return apiOk({});
}
