// Member-or-Admin: mail the caller a one-hour link that sets a new password
// (Account email, "Change own password"). The route exists only while account
// email is on; with it off, `../password` is the one way to change it. A reset
// mail goes only to a Confirmed email — an unconfirmed address may be a typo
// that belongs to someone else. Throttled per User: every call is a mail to a
// real inbox.

import { NextResponse } from 'next/server';
import { getConfirmedEmail } from '@liedmotif/db';
import { mailPasswordResetLink } from '@/lib/auth/account-mail';
import { apiError, apiOk, apiRateLimited, requireOwnerId } from '@/lib/http/api-response';
import { getDb } from '@/lib/db';
import { isAccountEmailEnabled } from '@/lib/env';
import { resetLinkMailLimiter } from '@/lib/http/request-limits';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  if (!isAccountEmailEnabled()) return apiError('not_found', 'Not found.');

  const db = getDb();
  const email = await getConfirmedEmail(db, ownerUserId);
  if (!email) return apiError('conflict', 'Confirm your email first.');

  const limit = resetLinkMailLimiter.check(ownerUserId);
  if (!limit.allowed) return apiRateLimited(limit.retryAfterMs);

  const sent = await mailPasswordResetLink(db, {
    userId: ownerUserId,
    email,
    createdByUserId: ownerUserId,
  });
  if (!sent) {
    return apiError('provider_error', 'The reset link could not be sent. Try again later.', {
      retryable: true,
    });
  }
  return apiOk({ sentTo: email });
}
