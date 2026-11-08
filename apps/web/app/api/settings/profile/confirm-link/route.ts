// Member-or-Admin: mail a confirm link to the caller's current sign-in address
// (Account email, "Confirm email"). The route exists only while account email
// is on. Throttled per User: every call is a mail to a real inbox.

import { NextResponse } from 'next/server';
import { getListenerProfile } from '@liedmotif/db';
import { mailConfirmLink } from '@/lib/account-mail';
import { apiError, apiOk, apiRateLimited, requireOwnerId } from '@/lib/api-response';
import { getDb } from '@/lib/db';
import { isAccountEmailEnabled } from '@/lib/env';
import { confirmLinkMailLimiter } from '@/lib/request-limits';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  if (!isAccountEmailEnabled()) return apiError('not_found', 'Not found.');

  const limit = confirmLinkMailLimiter.check(ownerUserId);
  if (!limit.allowed) return apiRateLimited(limit.retryAfterMs);

  const db = getDb();
  const profile = await getListenerProfile(db, ownerUserId);
  if (!profile) return apiError('not_found', 'Not found.');
  if (!(await mailConfirmLink(db, { userId: ownerUserId, email: profile.email }))) {
    return apiError('provider_error', 'The confirm link could not be sent. Try again later.', {
      retryable: true,
    });
  }
  return apiOk({});
}
