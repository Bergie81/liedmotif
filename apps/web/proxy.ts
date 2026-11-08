// Optimistic auth gate. A fast first pass that only checks for the PRESENCE
// of a Better Auth session cookie — it does NOT validate it. The authoritative checks
// live in the server-component guard (`requireAppAccess`), which reads the
// database and routes to setup/login/app correctly. A signed-out visitor to a
// protected route is bounced to `/login`, whose own guard forwards to `/setup`
// when no admin exists yet.
//
// The cookie is checked by NAME rather than importing `better-auth/cookies`, so no
// auth initialization is pulled into the proxy bundle. Better Auth names the cookie
// `better-auth.session_token`, prefixed with `__Secure-` when served over HTTPS.

import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE_NAMES = ['better-auth.session_token', '__Secure-better-auth.session_token'];

function hasSessionCookie(request: NextRequest): boolean {
  return SESSION_COOKIE_NAMES.some((name) => Boolean(request.cookies.get(name)?.value));
}

export function proxy(request: NextRequest) {
  if (hasSessionCookie(request)) {
    return NextResponse.next();
  }
  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = {
  // Protect every app route group — a signed-out hit gets this cheap cookie
  // redirect instead of a full RSC entry; auth, setup, and login stay open.
  matcher: [
    '/',
    '/library/:path*',
    '/player/:path*',
    '/search/:path*',
    '/sessions/:path*',
    '/settings/:path*',
    '/welcome',
  ],
};
