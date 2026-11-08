// The app's own policy bound to Better Auth's DEFAULT endpoints.
//
// `/api/auth/*` forwards every endpoint Better Auth ships, not just the ones the
// app's UI calls — so the library's 8-character default and its unvalidated
// `update-user` writes are reachable by any signed-in user unless the instance
// binds its own rules. These go through the real handler because the binding IS
// the behavior: a policy the factory forgets to wire refuses nothing.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { session, user, userProfiles } from '../schema';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { createAuth } from './index';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const BASE_URL = 'http://localhost:2206';
const SECRET = 'test-secret-not-a-placeholder-000000';
const COMPLIANT_PASSWORD = 'Correct-Horse-42';

describeIfDb('createAuth — app policy on the Better Auth default endpoints', () => {
  let ctx: TestDb;
  let refusals: string[];
  let auth: ReturnType<typeof createAuth>;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-auth-policy-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });

  beforeEach(async () => {
    await truncateTables(ctx.pool, ['user']);
    refusals = [];
    auth = createAuth(ctx.db, {
      secret: SECRET,
      baseURL: BASE_URL,
      // Stubbed so this file proves the FACTORY consults the policy; the app's
      // own rule (name length, avatar URL shape) is unit-tested where it lives.
      refuseUserUpdate: () => refusals.shift() ?? null,
    });
  });

  // Better Auth's own per-IP brake is on (3 attempts per 10s on the sign-in and
  // password paths). These tests are about the app's policy, not that brake, so
  // every request arrives from its own forwarded address and its own bucket.
  let callerCount = 0;

  function post(path: string, body: unknown, cookie?: string): Promise<Response> {
    callerCount += 1;
    return auth.handler(
      new Request(`${BASE_URL}/api/auth${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: BASE_URL,
          'x-forwarded-for': `203.0.113.${callerCount}`,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  }

  /** Sign up the first (and only) user and return their session cookie. */
  async function signUpAndGetCookie(): Promise<string> {
    const response = await post('/sign-up/email', {
      email: 'admin@example.test',
      password: COMPLIANT_PASSWORD,
      name: 'Admin',
    });
    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    return setCookie!.split(';')[0]!;
  }

  async function liveLoginCount(userId: string): Promise<number> {
    return (await ctx.db.select().from(session).where(eq(session.userId, userId))).length;
  }

  it('refuses a password the shared policy rejects, naming the unmet rule', async () => {
    // Long enough for Better Auth's own 8-character default, short for ours.
    const tooShort = await post('/change-password', {
      newPassword: 'Short-1!',
      currentPassword: COMPLIANT_PASSWORD,
    });
    expect(tooShort.status).toBe(400);
    expect(await tooShort.text()).toMatch(/12 characters/);

    const noComplexity = await post('/change-password', {
      newPassword: 'aaaaaaaaaaaaaaaa',
      currentPassword: COMPLIANT_PASSWORD,
    });
    expect(noComplexity.status).toBe(400);
    expect(await noComplexity.text()).toMatch(/uppercase/i);

    // 401, not 400: a compliant password reaches the endpoint and it is the
    // unauthenticated request that fails — the hook refuses passwords, not
    // password changes.
    const compliant = await post('/change-password', {
      newPassword: COMPLIANT_PASSWORD,
      currentPassword: COMPLIANT_PASSWORD,
    });
    expect(compliant.status).toBe(401);
  });

  // Better Auth leaves the eviction to a flag in the request body, so an
  // untouched instance rotates the credential and keeps every other Login alive.
  it('revokes the user’s other Logins on a successful password change', async () => {
    const first = await signUpAndGetCookie();
    const secondResponse = await post('/sign-in/email', {
      email: 'admin@example.test',
      password: COMPLIANT_PASSWORD,
    });
    expect(secondResponse.status).toBe(200);
    const userId = (await ctx.db.select().from(session))[0]!.userId;
    expect(await liveLoginCount(userId)).toBe(2);

    const changed = await post(
      '/change-password',
      { newPassword: 'Different-Horse-43', currentPassword: COMPLIANT_PASSWORD },
      first,
    );
    expect(changed.status).toBe(200);
    // One left, and the caller holds it: Better Auth issues the survivor.
    expect(await liveLoginCount(userId)).toBe(1);
    expect(changed.headers.get('set-cookie')).toBeTruthy();
  });

  // Disabling revokes the Logins; without a hook in the sign-in path the member
  // mints a fresh one on the next attempt and the revocation undoes itself.
  it('refuses a disabled member a Login, and gives it back on re-enable', async () => {
    await signUpAndGetCookie();
    const userId = (await ctx.db.select().from(user))[0]!.id;
    const setDisabled = (disabledAt: Date | null) =>
      ctx.db
        .update(userProfiles)
        .set({ role: 'member', disabledAt })
        .where(eq(userProfiles.userId, userId));

    await setDisabled(new Date());
    await ctx.db.delete(session); // what disabling itself does
    const refused = await post('/sign-in/email', {
      email: 'admin@example.test',
      password: COMPLIANT_PASSWORD,
    });
    expect(refused.status).toBe(401);
    expect(await liveLoginCount(userId)).toBe(0);

    await setDisabled(null);
    const allowed = await post('/sign-in/email', {
      email: 'admin@example.test',
      password: COMPLIANT_PASSWORD,
    });
    expect(allowed.status).toBe(200);
    expect(await liveLoginCount(userId)).toBe(1);
  });

  it('refuses a user update the app policy rejects, and allows the ones it does not', async () => {
    const cookie = await signUpAndGetCookie();

    refusals = ['Not a name we accept.'];
    const refused = await post('/update-user', { name: 'x'.repeat(500) }, cookie);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('Not a name we accept.');

    const allowed = await post('/update-user', { name: 'Renamed' }, cookie);
    expect(allowed.status).toBe(200);
  });

  // The avatar route serves the bytes of whichever user row references the URL,
  // so a second row pointing at someone else's avatar would either take their
  // picture over or make it 404. The shape check alone passes a copied URL.
  it('refuses an avatar URL another user already holds', async () => {
    const cookie = await signUpAndGetCookie();
    const victimImage = '/api/avatar/1f6e9a3c-2f47-4c31-9a1e-6bb0d0a3f5f1';
    await ctx.db.insert(user).values({
      id: 'victim-user',
      name: 'Victim',
      email: 'victim@example.test',
      image: victimImage,
    });

    const claimed = await post('/update-user', { image: victimImage }, cookie);
    expect(claimed.status).toBe(400);

    const holders = await ctx.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.image, victimImage));
    expect(holders).toEqual([{ id: 'victim-user' }]);

    const ownUpload = await post(
      '/update-user',
      { image: '/api/avatar/2a7f0b4d-3e58-4d42-8b2f-7cc1e1b4a6e2' },
      cookie,
    );
    expect(ownUpload.status).toBe(200);
  });

  // The profile route is the one place a sign-in email moves, and it refuses a
  // Member. A default endpoint that wrote the address would bypass that lock and
  // the Admin's password confirmation alike.
  it('moves the sign-in email through no default endpoint', async () => {
    const cookie = await signUpAndGetCookie();

    const viaUpdate = await post(
      '/update-user',
      { name: 'Renamed', email: 'elsewhere@example.test' },
      cookie,
    );
    expect(viaUpdate.ok).toBe(false);
    const viaChangeEmail = await post(
      '/change-email',
      { newEmail: 'elsewhere@example.test' },
      cookie,
    );
    expect(viaChangeEmail.ok).toBe(false);

    expect((await ctx.db.select({ email: user.email }).from(user))[0]?.email).toBe(
      'admin@example.test',
    );
  });
});
