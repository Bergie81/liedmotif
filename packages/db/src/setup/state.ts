// Setup-state detection and the single-admin lock.
//
// An instance has exactly one admin, created by the
// first-run setup wizard, after which setup LOCKS. The
// pure `resolveSetupState` decides what a request should see; the DB helpers
// answer "does an admin exist?" and enforce the lock. `assertCanCreateAdmin` is
// called both by the setup route and by the Better Auth `user.create.before`
// hook, so no path — not even the raw auth endpoint — can mint a second admin.

import { and, count, eq, isNull } from 'drizzle-orm';
import type { Database } from '../client';
import { ensureOwnerPerson } from '../people/people-repo';
import { resolveUserProfile } from '../profile/resolve-user-profile';
import { user, userProfiles } from '../schema';

/** Matches an ACTIVE admin profile (`role = 'admin'` and not disabled). */
const activeAdmin = and(eq(userProfiles.role, 'admin'), isNull(userProfiles.disabledAt));

/** What a request should be routed to, given setup + auth state. */
export type SetupState = 'setup' | 'login' | 'app';

/** Thrown when admin creation is attempted after the single admin already exists. */
export class SetupLockedError extends Error {
  constructor(message = 'Setup is locked: an admin already exists') {
    super(message);
    this.name = 'SetupLockedError';
  }
}

/**
 * Pure routing decision: no admin → run setup (a stray login cookie cannot jump
 * ahead of setup); admin but not signed in → login; admin and signed in → app.
 */
export function resolveSetupState(input: { adminExists: boolean; signedIn: boolean }): SetupState {
  if (!input.adminExists) return 'setup';
  return input.signedIn ? 'app' : 'login';
}

/** Number of ACTIVE admin profiles. Invariant: 0 (pre-setup) or 1. */
export async function countAdmins(db: Database): Promise<number> {
  const [row] = await db.select({ value: count() }).from(userProfiles).where(activeAdmin);
  return row?.value ?? 0;
}

/** Whether the instance has its single admin yet (i.e. setup is complete). */
export async function adminExists(db: Database): Promise<boolean> {
  return (await countAdmins(db)) > 0;
}

/**
 * Whether a specific user is the ACTIVE admin. Guards check this rather than
 * mere sign-in: a user without an admin profile (e.g. one stranded by a failed
 * setup race) must never be treated as the admin. A thin wrapper over the one
 * role-resolution seam so there are never two ways to ask.
 */
export async function isAdminUser(db: Database, userId: string): Promise<boolean> {
  const profile = await resolveUserProfile(db, userId);
  return profile?.role === 'admin' && profile.disabledAt === null;
}

/** Authoritative DB-backed routing decision. */
export async function getSetupState(
  db: Database,
  input: { signedIn: boolean },
): Promise<SetupState> {
  return resolveSetupState({ adminExists: await adminExists(db), signedIn: input.signedIn });
}

/**
 * The active admin's display identity — the "who pays for every generation"
 * line on a Member's budget surfaces. Null only before setup.
 */
export async function getAdminIdentity(
  db: Database,
): Promise<{ userId: string; name: string } | null> {
  const rows = await db
    .select({ userId: userProfiles.userId, name: user.name })
    .from(userProfiles)
    .innerJoin(user, eq(user.id, userProfiles.userId))
    .where(activeAdmin)
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The active Admin's Confirmed email, or null when there is none. Instance alerts
 * mail nowhere else: an unconfirmed address may be a typo that belongs to someone
 * else.
 */
export async function getAdminConfirmedEmail(db: Database): Promise<string | null> {
  const rows = await db
    .select({ email: user.email })
    .from(userProfiles)
    .innerJoin(user, eq(user.id, userProfiles.userId))
    .where(and(activeAdmin, eq(user.emailVerified, true)))
    .limit(1);
  return rows[0]?.email ?? null;
}

/**
 * The Admin's display name as copy names them — the person a used-up One-time
 * budget says to ask. Null before setup or when the name is blank.
 */
export async function getAdminDisplayName(db: Database): Promise<string | null> {
  const admin = await getAdminIdentity(db);
  return admin?.name.trim() || null;
}

/** Enforce the single-admin lock; throws `SetupLockedError` once an admin exists. */
export async function assertCanCreateAdmin(db: Database): Promise<void> {
  if (await adminExists(db)) {
    throw new SetupLockedError();
  }
}

/**
 * Create the admin profile (role `admin`) for a freshly-created user. Idempotent
 * on the user's primary key, so re-running setup glue never duplicates the row.
 */
export async function createAdminProfile(db: Database, userId: string): Promise<void> {
  await db
    .insert(userProfiles)
    .values({ userId, role: 'admin' })
    .onConflictDoNothing({ target: userProfiles.userId });
  await ensureOwnerPerson(db, userId);
}
