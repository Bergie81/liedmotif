// Unauthenticated "Forgot password?" (Account email). The reply is the same
// for every well-formed address — an account or not, confirmed or not,
// throttled or not — and it goes out before anything is looked up: the lookup
// and the mail run in `after()`, so neither the body nor the response time
// says whether an account exists. The route exists only while account email is
// on.

import { after, NextResponse } from 'next/server';
import { createLogger, forgotPasswordRequestSchema } from '@liedmotif/shared';
import { mailForgotPasswordLink } from '@/lib/account-mail';
import {
  apiError,
  apiOk,
  apiRateLimited,
  fieldErrorMessage,
  parseJsonBody,
  refuseCrossOrigin,
} from '@/lib/api-response';
import { getDb } from '@/lib/db';
import { isAccountEmailEnabled } from '@/lib/env';
import { clientIp } from '@/lib/http';
import { forgotPasswordLimiter, forgotPasswordMailLimiter } from '@/lib/request-limits';

export const dynamic = 'force-dynamic';

const logger = createLogger({ name: 'forgot-password' });

export async function POST(request: Request) {
  if (!isAccountEmailEnabled()) return apiError('not_found', 'Not found.');

  const crossOrigin = refuseCrossOrigin(request);
  if (crossOrigin) return crossOrigin;

  const limit = forgotPasswordLimiter.check(clientIp(request));
  if (!limit.allowed) return apiRateLimited(limit.retryAfterMs);

  const body = await parseJsonBody(
    request,
    forgotPasswordRequestSchema,
    fieldErrorMessage('email', 'Enter a valid email address.'),
  );
  if (body instanceof NextResponse) return body;

  const email = body.email.toLowerCase();
  if (forgotPasswordMailLimiter.check(email).allowed) {
    after(() =>
      // Nobody awaits this, and a database error's message carries the query's
      // parameters — the address — so only the error's name reaches the log.
      mailForgotPasswordLink(getDb(), { email }).catch((err: unknown) => {
        logger.error('forgot-password mail failed', {
          errorName: err instanceof Error ? err.name : typeof err,
        });
      }),
    );
  }
  return apiOk({});
}
