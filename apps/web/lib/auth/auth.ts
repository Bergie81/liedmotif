// The web process's Better Auth instance, bound to the cached web database.
//
// The factory (and Better Auth itself) live in `@liedmotif/db/auth`; this module
// only instantiates it with the web pool and runtime config. Server-only — never
// import from the client (it pulls the database and the auth secret).

import { createAuth, toNextJsHandler, type Auth } from '@liedmotif/db/auth';
import { getDb } from '@/lib/db';
import { getAuthSecret, getPublicUrl } from '../env';
import { refuseUserUpdate } from './user-update-policy';

const globalForAuth = globalThis as unknown as { __liedmotifAuth?: Auth };

/** The process-wide Better Auth instance (cached across Next dev HMR reloads). */
export function getAuth(): Auth {
  if (!globalForAuth.__liedmotifAuth) {
    globalForAuth.__liedmotifAuth = createAuth(getDb(), {
      secret: getAuthSecret(),
      baseURL: getPublicUrl(),
      refuseUserUpdate,
    });
  }
  return globalForAuth.__liedmotifAuth;
}

/** Next.js App Router GET/POST handlers for the mounted `/api/auth/*` routes. */
export function authRouteHandlers() {
  return toNextJsHandler(getAuth());
}
