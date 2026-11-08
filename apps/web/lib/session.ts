// Server-side session + setup-routing helpers.
//
// `getSetupState` is the authoritative gate (it reads the database): no admin →
// setup, admin but signed out → login, admin signed in → app. The page/layout
// guards below apply it with `redirect()`. A cookie-only middleware adds an
// optimistic first pass, but these server-side checks are the real boundary.
//
// Two access levels, honestly named (Invite Mode): Member-or-Admin
// (`getAppSession` / `requireAppAccess`) is the app — every signed-in user with
// an ACTIVE profile row, scoped to their own content by owner id. Admin-only
// (`getAdminSession` / `requireAdmin`) additionally requires `role = 'admin'`
// and guards instance configuration. Role and disabled state come from a
// per-request database read (`resolveUserProfile`), never from the session
// cookie — a cookie can outlive a disable by the cookie-cache window, and
// authorization must not.

import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSetupState } from '@liedmotif/db';
import { getAuth } from './auth';
import { getDb } from '@/lib/db';
import { hasCompletedOnboarding } from './onboarding-memo';
import { cachedUserProfile } from './request-cache';

type ServerSession = Awaited<ReturnType<ReturnType<typeof getAuth>['api']['getSession']>>;

// The reads below are wrapped in React's per-request `cache` because one server
// render legitimately asks the same questions several times: the protected layout,
// the settings layout, and the page each guard themselves — defense in depth. The
// cache lives for a single request; nothing is shared across requests or users.

/** The current Better Auth session (`{ session, user }`) or `null`. */
export const getServerSession = cache(async (): Promise<ServerSession> => {
  return getAuth().api.getSession({ headers: await headers() });
});

/**
 * Re-sign the session cookie cache from the database, best-effort. Sessions are
 * served from a signed cookie (`session.cookieCache`) that only Better Auth's
 * own mutation paths refresh — after a direct row write to a cached user field
 * (name, email), a route must force this database-backed read so renders don't
 * keep serving the previous value until the cache expires. A failed refresh
 * only extends that staleness to the cache's maxAge, which is never worth
 * failing a request whose own write already committed. Only meaningful from a
 * route handler or server action; an RSC render cannot set cookies.
 */
export async function refreshSessionCookieCache(): Promise<void> {
  await getAuth()
    .api.getSession({
      headers: await headers(),
      query: { disableCookieCache: true },
    })
    .catch(() => undefined);
}

/**
 * The token identifying the caller's OWN Login, or null when signed out. A
 * route that revokes a user's other Logins needs it to know which one is the
 * browser asking.
 */
export async function currentLoginToken(): Promise<string | null> {
  return (await getServerSession())?.session.token ?? null;
}

type AppAccess =
  | { kind: 'none' }
  | { kind: 'disabled'; session: NonNullable<ServerSession> }
  | { kind: 'active'; session: NonNullable<ServerSession>; role: 'admin' | 'member' };

/**
 * Classify the request: signed in with an active profile (and which role),
 * signed in but disabled, or effectively signed out. A session without a
 * profile row (e.g. stranded by a failed setup race) is treated as signed out —
 * it must never reach the app.
 */
async function resolveAppAccess(): Promise<AppAccess> {
  const session = await getServerSession();
  if (!session) return { kind: 'none' };
  const profile = await cachedUserProfile(getDb(), session.user.id);
  if (!profile) return { kind: 'none' };
  if (profile.disabledAt) return { kind: 'disabled', session };
  return { kind: 'active', session, role: profile.role };
}

/** What a guarded page gets: the live session plus the role already resolved for it. */
export interface ViewerAccess {
  session: NonNullable<ServerSession>;
  role: 'admin' | 'member';
}

/**
 * The signed-in user's account state, role-free, for the account-disabled page
 * to route on without leaking anything else.
 */
export async function resolveAccountState(): Promise<{ kind: 'none' | 'active' | 'disabled' }> {
  return { kind: (await resolveAppAccess()).kind };
}

/**
 * The page gate shared by every guard: an ACTIVE signed-in user (either role),
 * or redirected. A disabled user gets a stated destination — the
 * account-disabled page — never `/login`, which would bounce straight back.
 */
async function requireActiveUser(): Promise<Extract<AppAccess, { kind: 'active' }>> {
  const access = await resolveAppAccess();
  if (access.kind === 'active') return access;
  if (access.kind === 'disabled') redirect('/account-disabled');
  // Being signed in as an active user already proves an admin exists, so the
  // counting query only runs for a request that is not.
  const state = await getSetupState(getDb(), { signedIn: false });
  redirect(state === 'setup' ? '/setup' : '/login');
}

/**
 * Divert a signed-in user into first-login onboarding until it is finished. It sits
 * behind the setup/auth checks, so it never runs for a request that has no business
 * in the app at all.
 */
async function requireOnboarded(userId: string): Promise<void> {
  if (!(await hasCompletedOnboarding(getDb(), userId))) redirect('/welcome');
}

/**
 * Guard for the protected app + settings route group. Redirects to setup, login,
 * the account-disabled page, or onboarding unless an active user is signed in and
 * onboarded. Admits both roles — every page under it scopes its work to the
 * returned session's own user id — and hands back the role it already resolved,
 * so a page that renders differently per role never asks a second time.
 */
export async function requireAppAccess(): Promise<ViewerAccess> {
  const access = await requireActiveUser();
  await requireOnboarded(access.session.user.id);
  return { session: access.session, role: access.role };
}

/**
 * Guard for admin-only PAGES (instance configuration). On top of app access it
 * requires `role = 'admin'`; a signed-in Member is sent back to the app rather
 * than rendered. Every admin-only page keeps calling this itself — filtering a
 * hub or nav is presentation, this guard is the boundary.
 */
export async function requireAdmin(): Promise<NonNullable<ServerSession>> {
  const access = await requireAppAccess();
  if (access.role !== 'admin') redirect('/');
  return access.session;
}

/**
 * Guard for the first-login onboarding flow: an active user (either role) must be
 * signed in, and one who has already been through it is sent to the app so the
 * flow can never be replayed by URL.
 */
export async function requireOnboardingAccess(): Promise<ViewerAccess> {
  const access = await requireActiveUser();
  if (await hasCompletedOnboarding(getDb(), access.session.user.id)) redirect('/');
  return { session: access.session, role: access.role };
}

/** Guard for the login page: bounce to setup (no admin) or the app (already in). */
export async function redirectAwayFromLogin(): Promise<void> {
  const state = await currentSetupState();
  if (state === 'setup') redirect('/setup');
  if (state === 'app') redirect('/');
}

/** Guard for the setup wizard: once an admin exists, setup is locked — send away. */
export async function redirectAwayFromSetup(): Promise<void> {
  const state = await currentSetupState();
  // Past setup, `state` already encodes active sign-in: 'app' = signed in, 'login' = not.
  if (state !== 'setup') redirect(state === 'app' ? '/' : '/login');
}

/**
 * Resolve the authoritative setup/auth routing state. "Signed in" means signed in
 * as an ACTIVE user — a disabled or profile-less session is treated as not signed
 * in for routing purposes, so it can never reach the app.
 */
async function currentSetupState() {
  const access = await resolveAppAccess();
  if (access.kind === 'active') return 'app' as const;
  return getSetupState(getDb(), { signedIn: false });
}

/**
 * Member-or-Admin gate for API routes: returns the session only when the request
 * is signed in as an ACTIVE user (either role), else `null` (the caller returns
 * 401). This is the guard the content routes build on — the value they scope
 * their work to is the signed-in user's own id.
 */
export async function getAppSession(): Promise<ServerSession> {
  const access = await resolveAppAccess();
  return access.kind === 'active' ? access.session : null;
}

/**
 * Admin-only gate for API routes: returns the session only when the request is
 * signed in as the ACTIVE admin, else `null` (the caller returns 401). Instance
 * configuration routes (credentials, limits, cover-art, voice,
 * diagnostics, members) use this; content routes use `getAppSession`.
 */
export async function getAdminSession(): Promise<ServerSession> {
  const access = await resolveAppAccess();
  return access.kind === 'active' && access.role === 'admin' ? access.session : null;
}
