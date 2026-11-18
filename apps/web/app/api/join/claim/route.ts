// Unauthenticated invite claim: turn a one-shot link into a Member.
//
// Fail closed and opaque: unknown, expired, revoked, and consumed tokens all
// answer the same refusal, throttled per IP, and the token never reaches a log
// line. A signed-in caller is refused outright — a claim link must never swap
// the account under whoever is looking at it.

import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { claimMemberInvite } from '@liedmotif/db';
import { claimInviteRequestSchema } from '@liedmotif/shared';
import {
  apiError,
  apiOk,
  apiRateLimited,
  fieldErrorMessage,
  parseJsonBody,
  refuseCrossOrigin,
} from '@/lib/api-response';
import { getAuth } from '@/lib/auth';
import { INVALID_LINK_MESSAGE } from '@/lib/constants';
import { getDb } from '@/lib/db';
import { clientIp } from '@/lib/http';
import { linkTokenLimiter } from '@/lib/request-limits';
import { getServerSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  // Stated here because this route carries no auth guard to state it for them:
  // a claim ends in a Login, so a forged cross-site post would sign the victim's
  // browser into an account whose password the attacker chose.
  const crossOrigin = refuseCrossOrigin(request);
  if (crossOrigin) return crossOrigin;

  const limit = linkTokenLimiter.check(clientIp(request));
  if (!limit.allowed) return apiRateLimited(limit.retryAfterMs);

  if (await getServerSession()) {
    return apiError('conflict', 'You are already signed in. Sign out first to accept an invite.');
  }

  const body = await parseJsonBody(
    request,
    claimInviteRequestSchema,
    fieldErrorMessage('password', 'Invalid claim.'),
  );
  if (body instanceof NextResponse) return body;

  const result = await claimMemberInvite(getDb(), body);
  if (!result.ok) {
    if (result.reason === 'email_in_use') {
      return apiError('validation_error', 'That email is already in use. Pick another.');
    }
    // An emailed Invite's address is fixed, so the claimer cannot pick another.
    if (result.reason === 'invite_email_in_use') {
      return apiError(
        'validation_error',
        'Someone already signs in with this invite’s address. Ask your admin for a new invite.',
      );
    }
    return apiError('not_found', INVALID_LINK_MESSAGE);
  }

  // Sign the new Member in; `nextCookies` forwards the session cookie. If this
  // step fails the account still exists, so the claimer lands on /login rather
  // than losing the claim.
  let signedIn = true;
  try {
    await getAuth().api.signInEmail({
      body: { email: result.email, password: body.password },
      headers: await headers(),
    });
  } catch {
    signedIn = false;
  }
  return apiOk({ signedIn });
}
