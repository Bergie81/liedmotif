// Better Auth's catch-all endpoint (sign-in, sign-out, get-session, …), mounted
// via Better Auth's Next.js handler. The client talks to these routes with plain
// fetch; no provider secret ever passes through here.
//
// The handlers are resolved lazily (per request) rather than at module load, so
// `next build` — which imports route modules — never constructs the auth instance
// (and never demands the runtime secret) at build time.
//
// PUBLIC self-service sign-up is disabled: the single admin is created ONLY through
// /api/setup, which calls `auth.api.signUpEmail` server-side (an in-process call
// that does NOT go through this HTTP handler). The `user.create.before`
// single-admin hook remains the backstop.
//
// The endpoints that VERIFY a secret are rate-limited app-level,
// keyed on the client IP the same way as the setup routes, instead of relying on
// Better Auth's proxy-address default. Only FAILED attempts consume budget —
// a correct answer is free — so the limiter is a brute-force guard, not a
// throttle on legitimate use.

import { NextResponse } from 'next/server';
import { authRouteHandlers } from '@/lib/auth';
import { clientIp, tooManyRequests } from '@/lib/http';
import { loginFailureLimiter } from '@/lib/request-limits';

export const dynamic = 'force-dynamic';

/**
 * The Better Auth POSTs that answer whether a presented secret was right, and
 * therefore the ones an attacker can guess against: every `/sign-in/*` variant.
 */
const CREDENTIAL_PATH = '/sign-in';

/**
 * Better Auth's own password-reset, email-verification, and password-setting
 * endpoints, GET callbacks included. The `invites` table is the one link
 * machinery (Account email): `/verify-email` sets a Confirmed email from a token
 * alone, and on its email-change branch moves the address and signs the caller
 * in. The auth config enables none of the token flows today (no
 * `sendResetPassword`, no `emailVerification`, so nothing mints their tokens);
 * refusing them here keeps a later config change from opening a second token
 * flow beside the throttled single-use links. `/forget-password` is the
 * library's former name for the reset request. A signed-in User sets a password
 * only through the app's own paths — a reset link, or, with account email off,
 * Settings → Profile's form, whose route verifies the current password under the
 * sign-in throttle and revokes the other Logins itself — so `/change-password`
 * and `/set-password` are refused as well. `/verify-password` answers whether a
 * password is right for the caller's Login with only the library's own brake; the
 * app checks passwords server-side (`verifyCredentialPassword`), so it is refused
 * rather than left as an unthrottled guessing oracle. `/update-user` would write
 * `name` and `image` past the profile and avatar routes; repointing `image` there
 * strands the replaced avatar's bytes, which only the avatar route queues for
 * deletion.
 */
const REFUSED_PATHS = [
  '/request-password-reset',
  '/forget-password',
  '/reset-password',
  '/send-verification-email',
  '/verify-email',
  '/change-password',
  '/set-password',
  '/verify-password',
  '/update-user',
];

function refused(pathname: string): NextResponse | null {
  return REFUSED_PATHS.some((path) => pathname.includes(path))
    ? NextResponse.json({ error: 'Not found.' }, { status: 404 })
    : null;
}

export function GET(request: Request) {
  return refused(new URL(request.url).pathname) ?? authRouteHandlers().GET(request);
}

export async function POST(request: Request) {
  const { pathname } = new URL(request.url);
  const refusal = refused(pathname);
  if (refusal) return refusal;
  if (pathname.includes('/sign-up')) {
    return NextResponse.json({ error: 'Sign-up is disabled.' }, { status: 403 });
  }
  if (!pathname.includes(CREDENTIAL_PATH)) {
    return authRouteHandlers().POST(request);
  }

  const ip = clientIp(request);
  // Consumed BEFORE the credential check: recording the hit afterwards lets every
  // request of a parallel burst clear the gate before the first failure lands,
  // buying more verifications than the window budgets.
  const budget = loginFailureLimiter.check(ip);
  if (!budget.allowed) return tooManyRequests(budget.retryAfterMs);

  const response = await authRouteHandlers().POST(request);
  // Only a rejected attempt (bad credentials, bad payload) costs budget; the
  // presented secret being right refunds the unit. A thrown handler keeps it.
  if (response.status < 400) loginFailureLimiter.refund(ip);
  return response;
}
