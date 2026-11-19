// First-run setup: create the single admin and record the instance.
//
// Rate-limited and guarded by the single-admin lock (the Better Auth
// `user.create.before` hook is the backstop). No provider secret passes through
// here — first-login onboarding stores those through the same route Settings uses.
// On success the admin is signed in (autoSignIn + nextCookies set the session
// cookie) and setup is marked complete, after which it locks.

import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import {
  SetupLockedError,
  adminExists,
  assertCanCreateAdmin,
  markSetupComplete,
  upsertInstanceSettings,
  withSetupAdvisoryLock,
} from '@liedmotif/db';
import { createLogger } from '@liedmotif/shared';
import { getAuth } from '@/lib/auth/auth';
import { DEFAULT_INSTANCE_NAME } from '@/lib/constants';
import { getDb, getPool } from '@/lib/db';
import { getPublicUrl } from '@/lib/env';
import { getStorageProvider } from '@/lib/providers/providers';
import { readJsonObjectBody, refuseSetupCrossOrigin } from '@/lib/http/api-response';
import { badRequest, clientIp, tooManyRequests } from '@/lib/http/http';
import { submitLimiter } from '@/lib/http/request-limits';
import { setupTokenRefusal } from '@/lib/auth/setup-token';
import {
  SetupValidationError,
  parseSetupPayload,
  type SetupPayload,
} from '@/lib/auth/setup-validation';

const log = createLogger({ name: 'web-setup' });

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  // This route has no auth guard to carry the Origin refusal, and it mints the
  // sole administrator: a cross-site form post from a page the operator opens
  // while the instance is still unclaimed would hand the account — and the
  // permanent single-admin lock — to whoever served that page. Ahead of the
  // limiter so forged traffic never spends the victim's bucket.
  const crossOrigin = refuseSetupCrossOrigin(request);
  if (crossOrigin) return crossOrigin;

  const limit = submitLimiter.check(clientIp(request));
  if (!limit.allowed) return tooManyRequests(limit.retryAfterMs);

  // Bootstrap authority, carried on the very request that creates the admin —
  // there is no separate unlock step, so no window exists between proving the
  // token and claiming the account. Ahead of the database work so an unproven
  // caller costs nothing but the already-charged rate-limit slot.
  const refusal = setupTokenRefusal(request);
  if (refusal) return refusal;

  const db = getDb();

  // Lock pre-check (the auth hook re-checks atomically during sign-up).
  try {
    await assertCanCreateAdmin(db);
  } catch (err) {
    if (err instanceof SetupLockedError) {
      return NextResponse.json({ ok: false, error: 'Setup is already complete.' }, { status: 409 });
    }
    throw err;
  }

  const body = await readJsonObjectBody(request);
  if (body instanceof NextResponse) return body;

  let payload: SetupPayload;
  try {
    payload = parseSetupPayload(body);
  } catch (err) {
    if (err instanceof SetupValidationError) return badRequest(err.message);
    return badRequest('Invalid request body.');
  }

  // Serialize the whole critical section under a Postgres advisory lock so two
  // concurrent first-run submits can't interleave: the loser blocks on the lock,
  // then sees the admin already exists and writes nothing.
  return withSetupAdvisoryLock(getPool(), async () => {
    // Authoritative re-check INSIDE the lock (the outer check was an optimistic
    // fast-fail): a losing racer observes the winner's committed admin here.
    if (await adminExists(db)) {
      return NextResponse.json({ ok: false, error: 'Setup is already complete.' }, { status: 409 });
    }

    // Record the instance FIRST. It is owner-less and idempotent, and creating the
    // admin is what LOCKS setup — so doing config first means a sign-up failure
    // leaves a retryable (still-unlocked) instance rather than a locked,
    // half-configured one. Nothing in it is asked for: the public URL is whatever
    // `APP_PUBLIC_URL` already serves, and typing a different one here could not
    // change that.
    await upsertInstanceSettings(db, { name: DEFAULT_INSTANCE_NAME, publicUrl: getPublicUrl() });
    // A new install's usage limits, written here because the Docker stack never
    // runs `db:seed`: without a stored row the read-time defaults would hold the
    // Admin to Track and Cover ceilings that are opt-in.
    // Idempotent, so limits an earlier `db:seed` wrote are kept. The
    // `@liedmotif/db/seed` module is imported lazily to keep it off the hot path.
    const { ensurePlaceholderCover, seedAppSettings } = await import('@liedmotif/db/seed');
    await seedAppSettings(db);

    // Create the admin LAST (this locks setup); auto sign-in + nextCookies set the
    // session cookie.
    try {
      await getAuth().api.signUpEmail({
        body: {
          email: payload.admin.email,
          password: payload.admin.password,
          // Nameless on purpose: onboarding asks the owner their first name on its
          // first screen, and a placeholder here would arrive pre-filled as an
          // answer nobody gave. The owner Person is provisioned under
          // `OWNER_PERSON_FALLBACK_NAME` and follows that first name once typed.
          name: '',
        },
        headers: await headers(),
      });
    } catch (err) {
      // Single-admin hook or a duplicate email rejects here — message stays generic.
      // Log only the message string, never the raw error object (a future provider
      // error could carry endpoint/credential detail).
      log.warn('admin sign-up rejected during setup', {
        err: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        { ok: false, error: 'Could not create the admin account.' },
        { status: 409 },
      );
    }

    await markSetupComplete(db);

    // Provision the built-in placeholder cover (DB row + storage bytes) so fresh
    // sessions have cover art from day one. Best-effort and idempotent: cover art
    // is cosmetic, and both `npm run db:seed` and the covers route's own heal can
    // still provision it, so a failure here must not fail setup.
    try {
      const outcome = await ensurePlaceholderCover(db, getStorageProvider());
      log.info('placeholder cover ensured', { bytes: outcome });
    } catch (err) {
      // Sanitized: a remote storage provider's error could leak endpoint detail.
      log.warn('placeholder cover provisioning skipped', {
        err: err instanceof Error ? err.message : String(err),
      });
    }

    log.info('setup completed', { email: payload.admin.email });
    return NextResponse.json({ ok: true });
  });
}
