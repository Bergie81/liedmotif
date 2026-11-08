// Better Auth instance factory.
//
// Lives in `@liedmotif/db` (next to the schema Better Auth owns) and is reached via
// the `@liedmotif/db/auth` subpath, so importing it is opt-in: the worker daemon
// and the web app's data layer never pull Better Auth's runtime unless they ask
// for auth. `better-auth/next-js` is imported here, but it only loads `next/headers`
// lazily inside the cookie hook, so this module is safe to import outside Next too.
//
// One admin per instance: the `user.create.before` hook enforces the lock at the
// lowest level — even the raw sign-up endpoint cannot create a second admin — and
// `after` promotes the first (and only) sign-up to admin. Email verification is
// OFF (account email is optional) and sign-up auto-signs-in so the setup wizard
// lands the admin straight in the app.

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { nextCookies, toNextJsHandler } from 'better-auth/next-js';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, validatePassword } from '@liedmotif/shared';
import type { Database } from '../client';
import { getAvatarOwnerUserId } from '../profile/profile-repo';
import { resolveUserProfile } from '../profile/resolve-user-profile';
import { adminExists, createAdminProfile } from '../setup/state';

export { toNextJsHandler };

export interface CreateAuthOptions {
  /** Session-signing secret (`BETTER_AUTH_SECRET`). */
  secret: string;
  /** Public base URL the instance is served from (`APP_PUBLIC_URL`). */
  baseURL: string;
  /** Extra trusted origins for CSRF/redirect safety (defaults to `baseURL`). */
  trustedOrigins?: string[];
  /**
   * The app's own rule for a `user` row write, as a refusal message or `null`
   * to allow. `POST /update-user` is a default endpoint every signed-in user
   * can reach, and it writes `name`/`image` straight through — so whatever the
   * app's forms and upload pipeline enforce has to be stated here too, or it is
   * enforced nowhere. The rule is the caller's because the shapes it judges
   * (an avatar URL is an app ROUTE) belong to the app, not to this layer.
   *
   * Required, deliberately: an instance that forgot to pass one would be back
   * to the unvalidated endpoint with nothing to show for it.
   */
  refuseUserUpdate: (update: UserUpdateFields) => string | null;
}

/** The `user` row fields Better Auth's default endpoint lets a caller write. */
export interface UserUpdateFields {
  name?: unknown;
  image?: unknown;
}

/**
 * The Better Auth endpoints that store a plaintext password, and the body field
 * each carries it in. Better Auth checks only its own length floor; the shared
 * policy (`validatePassword`) is what every app-owned surface enforces, so the
 * default endpoints have to be held to it as well or they are the way around it.
 */
const PASSWORD_FIELD_BY_PATH: Readonly<Record<string, string>> = {
  '/sign-up/email': 'password',
  '/change-password': 'newPassword',
  '/set-password': 'newPassword',
  '/reset-password': 'newPassword',
};

/** Hold every password-storing endpoint to the shared policy before it runs. */
function assertPasswordPolicy(path: string, body: Record<string, unknown> | undefined): void {
  const field = PASSWORD_FIELD_BY_PATH[path];
  if (!field) return;
  const password = body?.[field];
  // A non-string is the endpoint schema's refusal to make, not ours.
  if (typeof password !== 'string') return;
  const refusal = validatePassword(password);
  if (refusal) throw new APIError('BAD_REQUEST', { message: refusal });
}

/**
 * The app's rules on Better Auth's own endpoints. The library takes exactly one
 * `before` hook, so both live here.
 */
const authEndpointPolicy = createAuthMiddleware(async (ctx) => {
  const body = ctx.body as Record<string, unknown> | undefined;
  assertPasswordPolicy(ctx.path, body);
  // Rotating a password is what evicts whoever stole a Login, which is why every
  // app-owned rotation path (invite claim, admin reset, email change) revokes
  // the user's other Logins. Better Auth leaves it to a flag in the request
  // body — and the one caller with a reason to omit it is the one holding the
  // stolen cookie — so the instance decides, not the caller.
  if (ctx.path === '/change-password') {
    return { context: { body: { ...body, revokeOtherSessions: true } } };
  }
});

/** The concrete auth instance type, for typing helpers in the web app. */
export type Auth = ReturnType<typeof createAuth>;

/**
 * Build the Better Auth instance bound to a given Drizzle database. The same `db`
 * backs the single-admin hooks, so the lock and the admin-profile creation run in
 * the instance's own data layer.
 */
export function createAuth(db: Database, options: CreateAuthOptions) {
  return betterAuth({
    secret: options.secret,
    baseURL: options.baseURL,
    trustedOrigins: options.trustedOrigins ?? [options.baseURL],
    database: drizzleAdapter(db, { provider: 'pg' }),
    session: {
      // Serve `getSession` from a signed short-lived cookie between database
      // refreshes. Every authenticated request (JSON, queue polls, cover and
      // audio byte serving) otherwise pays two session queries.
      //
      // `maxAge` is the cost of the trade: a deleted `session` row keeps
      // answering from the signed cookie for that long, so it is the residual
      // window on every revocation — member disable, and the password resets
      // that exist to evict a session thief. One minute keeps recovery
      // effectively prompt while a request still avoids the session queries
      // through a burst of playback polling. Role and disabled state are never
      // cached: the guards re-read them from the database per request.
      cookieCache: {
        enabled: true,
        maxAge: 60,
      },
    },
    emailAndPassword: {
      enabled: true,
      // Account email is optional: do not gate sign-in on email verification.
      requireEmailVerification: false,
      // Sign the new admin in immediately so setup flows straight into the app.
      autoSignIn: true,
      // The shared policy's bounds, so the library's own refusals agree with it.
      // Everything between them still goes through `assertPasswordPolicy`.
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
    },
    // Better Auth's own brake defaults to on only where `NODE_ENV` reads
    // "production" — a security control that switches itself off on a wrong env
    // var. Stated here so it is on wherever this instance runs.
    rateLimit: { enabled: true },
    hooks: {
      before: authEndpointPolicy,
    },
    databaseHooks: {
      user: {
        create: {
          // Single-admin lock: refuse to create a user once an admin exists.
          before: async () => {
            if (await adminExists(db)) return false;
          },
          // The first (only) user becomes the admin.
          after: async (created) => {
            await createAdminProfile(db, created.id);
          },
        },
        update: {
          // At the database layer, so the app's own server-side `updateUser`
          // calls (the avatar route) are held to the same rule as the endpoint.
          before: async (update) => {
            const refusal = options.refuseUserUpdate(update);
            if (refusal) throw new APIError('BAD_REQUEST', { message: refusal });
            // Every upload mints a fresh avatar URL, and the avatar route serves
            // the bytes of whichever row references it — so a URL already on a
            // row can only be someone else's picture (or a no-op re-set).
            if (
              typeof update.image === 'string' &&
              (await getAvatarOwnerUserId(db, update.image))
            ) {
              throw new APIError('BAD_REQUEST', {
                message: 'Profile image must be your own uploaded avatar.',
              });
            }
          },
        },
      },
      session: {
        create: {
          // Disabling a Member revokes their Logins, and nothing else in the
          // sign-in path reads the profile — so they would simply sign in again
          // and mint a fresh one, undoing the revocation. The app's per-request
          // guards refuse them either way, but "disabled" has to mean "cannot
          // authenticate". The refusal is worded like the library's own
          // invalid-credentials answer so it confirms nothing about the account.
          //
          // A user with NO profile row is mid-sign-up (`user.create.after`
          // writes it), so only a set `disabledAt` refuses.
          before: async (created) => {
            const profile = await resolveUserProfile(db, created.userId);
            if (profile?.disabledAt) {
              throw new APIError('UNAUTHORIZED', { message: 'Invalid email or password' });
            }
          },
        },
      },
    },
    // `nextCookies` MUST be last: it forwards Set-Cookie from server-side
    // `auth.api` calls (e.g. the setup route's sign-up) into Next's cookie store.
    plugins: [nextCookies()],
  });
}
