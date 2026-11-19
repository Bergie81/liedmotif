// Member-or-Admin: change the caller's own password with the current one
// (Account email off, "Change own password"). The route exists only while
// account email is off; with it on, `../reset-link` is the one way to change it.
// A session cookie alone never sets a password: the current one is verified
// under the sign-in failure throttle, and every other Login is revoked with the
// rotation.

import { NextResponse } from 'next/server';
import { changeOwnPassword, verifyCredentialPassword } from '@liedmotif/db';
import { changePasswordRequestSchema } from '@liedmotif/shared';
import {
  apiError,
  apiOk,
  apiRateLimited,
  fieldErrorMessage,
  parseJsonBody,
  requireOwnerId,
} from '@/lib/http/api-response';
import { getDb } from '@/lib/db';
import { isAccountEmailEnabled } from '@/lib/env';
import { clientIp } from '@/lib/http/http';
import { loginFailureLimiter } from '@/lib/http/request-limits';
import { currentLoginToken } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  if (isAccountEmailEnabled()) return apiError('not_found', 'Not found.');

  const body = await parseJsonBody(
    request,
    changePasswordRequestSchema,
    fieldErrorMessage('newPassword', 'Enter your current password and a new one.'),
  );
  if (body instanceof NextResponse) return body;

  // The same budget and order as `/sign-in`: consumed before the check, so a
  // parallel burst cannot clear the gate before its first failure lands, and
  // refunded once the current password proves right.
  const ip = clientIp(request);
  const budget = loginFailureLimiter.check(ip);
  if (!budget.allowed) return apiRateLimited(budget.retryAfterMs);

  const db = getDb();
  if (!(await verifyCredentialPassword(db, ownerUserId, body.currentPassword))) {
    return apiError('validation_error', 'That password is not correct.');
  }
  loginFailureLimiter.refund(ip);

  // Without knowing which Login is this browser there is no safe revocation to
  // perform, so the change does not happen at all.
  const keepLoginToken = await currentLoginToken();
  if (!keepLoginToken) {
    return apiError('unauthorized', 'Could not confirm your sign-in. Sign in again.');
  }

  await changeOwnPassword(db, {
    userId: ownerUserId,
    newPassword: body.newPassword,
    keepLoginToken,
  });
  return apiOk({});
}
