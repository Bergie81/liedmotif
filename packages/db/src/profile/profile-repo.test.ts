// Integration tests for the listener-profile repo (real Postgres via
// TEST_DATABASE_URL, like the other db suites; skipped when unset).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { canonicalPersonName, DEFAULT_MEMBER_LIMITS } from '@liedmotif/shared';
import {
  createPerson,
  ensureOwnerPerson,
  listPeople,
  MAX_PERSON_NAME_LENGTH,
  OWNER_PERSON_FALLBACK_NAME,
  updatePerson,
} from '../people/people-repo';
import { session, user } from '../schema';
import { createLogin } from '../generation/test-fixtures';
import {
  createMemberInvite,
  createPasswordResetLink,
  findClaimableLink,
  revokeInvite,
} from '../invites/invites-repo';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { getListenerContext, getListenerProfile, updateListenerProfile } from './profile-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

async function seedUser(ctx: TestDb, email: string): Promise<string> {
  const userId = randomUUID();
  await ctx.db.insert(user).values({ id: userId, name: 'John', email });
  return userId;
}

describeIfDb('listener-profile repo', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-profile-test');
  }, 60_000);

  afterAll(async () => {
    await ctx?.pool.end();
  });

  beforeEach(async () => {
    // Cascades to `listener_profiles` via the owner FK.
    await truncateTables(ctx.pool, ['user']);
  });

  it('reads auth name/email with empty details before the first save', async () => {
    const userId = await seedUser(ctx, 'admin@example.test');
    expect(await getListenerProfile(ctx.db, userId)).toEqual({
      name: 'John',
      email: 'admin@example.test',
      city: '',
      country: '',
      artistName: '',
      description: '',
    });
  });

  it('returns null for an unknown user', async () => {
    expect(await getListenerProfile(ctx.db, randomUUID())).toBeNull();
  });

  it('upserts the profile row and updates the auth name/email (second save overwrites)', async () => {
    const userId = await seedUser(ctx, 'admin@example.test');
    const first = {
      name: 'Tom',
      email: 'tom@example.test',
      city: 'Munich',
      country: 'Germany',
      artistName: 'DJ Tom',
      description: 'Night owl, synth collector.',
    };
    await updateListenerProfile(ctx.db, userId, first);
    expect(await getListenerProfile(ctx.db, userId)).toEqual(first);

    const second = { ...first, city: 'Innsbruck', artistName: '  ', description: '  ' };
    await updateListenerProfile(ctx.db, userId, second);
    // A blank artist name or description stores NULL and reads back as '' (unset).
    expect(await getListenerProfile(ctx.db, userId)).toEqual({
      ...second,
      artistName: '',
      description: '',
    });
  });

  it('builds the LLM context from non-empty fields only and NEVER includes the email or description', async () => {
    const userId = await seedUser(ctx, 'admin@example.test');
    await updateListenerProfile(ctx.db, userId, {
      name: 'Tom',
      email: 'tom@example.test',
      city: '  ',
      country: 'Germany',
      artistName: 'DJ Tom',
      description: 'Night owl, synth collector.',
    });
    expect(await getListenerContext(ctx.db, userId)).toEqual({
      name: 'Tom',
      country: 'Germany',
    });
  });

  it('returns a null context when every field is blank (skip personalization entirely)', async () => {
    const userId = await seedUser(ctx, 'admin@example.test');
    await updateListenerProfile(ctx.db, userId, {
      name: ' ',
      email: 'tom@example.test',
      city: '',
      country: '',
      artistName: '',
      description: '',
    });
    // Export metadata is deliberately NOT LLM context.
    expect(await getListenerContext(ctx.db, userId)).toBeNull();
  });

  // Moving the login email is what makes the Login set stale, so the two change
  // in one commit: the browser doing it stays in, every other one is evicted,
  // and a rejected write revokes nobody.
  it('revokes the user’s other Logins with the email, sparing the named one', async () => {
    const userId = await seedUser(ctx, 'admin@example.test');
    const otherUserId = await seedUser(ctx, 'member@example.test');
    await createLogin(ctx.db, userId, 'this-browser');
    await createLogin(ctx.db, userId, 'an-old-phone');
    await createLogin(ctx.db, otherUserId, 'someone-else');

    await updateListenerProfile(
      ctx.db,
      userId,
      {
        name: 'John',
        email: 'moved@example.test',
        city: '',
        country: '',
        artistName: '',
        description: '',
      },
      { revokeOtherLoginsExcept: 'this-browser' },
    );

    const remaining = await ctx.db.select({ token: session.token }).from(session);
    expect(remaining.map((row) => row.token).sort()).toEqual(['someone-else', 'this-browser']);
  });

  it('leaves every Login alone when the write revokes nothing', async () => {
    const userId = await seedUser(ctx, 'admin@example.test');
    await createLogin(ctx.db, userId, 'this-browser');
    await createLogin(ctx.db, userId, 'an-old-phone');

    await updateListenerProfile(ctx.db, userId, {
      name: 'Renamed',
      email: 'admin@example.test',
      city: '',
      country: '',
      artistName: '',
      description: '',
    });

    expect(await ctx.db.select({ token: session.token }).from(session)).toHaveLength(2);
  });

  // A confirmed address is one its owner proved they read; a new address has
  // proved nothing, whichever route moved it.
  it('clears Confirmed email when the address moves, and keeps it when only other fields change', async () => {
    const userId = await seedUser(ctx, 'admin@example.test');
    await ctx.db.update(user).set({ emailVerified: true }).where(eq(user.id, userId));
    const confirmed = async () =>
      (
        await ctx.db
          .select({ emailVerified: user.emailVerified })
          .from(user)
          .where(eq(user.id, userId))
      )[0]?.emailVerified;
    const profile = { name: 'Renamed', city: '', country: '', artistName: '', description: '' };

    await updateListenerProfile(ctx.db, userId, { ...profile, email: 'admin@example.test' });
    expect(await confirmed()).toBe(true);

    await updateListenerProfile(ctx.db, userId, { ...profile, email: 'moved@example.test' });
    expect(await confirmed()).toBe(false);
  });

  // A reset link mailed to the old address would otherwise outlive the move: the
  // inbox the account just left could still set its password.
  it('voids the open reset links when the address moves, and keeps them when it does not', async () => {
    const userId = await seedUser(ctx, 'admin@example.test');
    const mintReset = async () =>
      (
        await createPasswordResetLink(ctx.db, {
          targetUserId: userId,
          label: 'admin@example.test',
          createdByUserId: userId,
        })
      ).token;
    const resetWorks = async (token: string) =>
      (await findClaimableLink(ctx.db, { kind: 'password_reset', token })) !== null;
    const profile = { name: 'John', city: '', country: '', artistName: '', description: '' };

    const kept = await mintReset();
    await updateListenerProfile(ctx.db, userId, { ...profile, email: 'admin@example.test' });
    expect(await resetWorks(kept)).toBe(true);

    await updateListenerProfile(ctx.db, userId, { ...profile, email: 'moved@example.test' });
    expect(await resetWorks(kept)).toBe(false);
  });

  // An emailed Invite is bound to its address, so a User moving onto it first
  // would leave the invitee a link they can never claim.
  describe('an address an open Invite carries', () => {
    const profile = { name: 'John', city: '', country: '', artistName: '', description: '' };
    const inviteAnna = (createdByUserId: string, extra: { expiresAt?: Date } = {}) =>
      createMemberInvite(ctx.db, {
        label: 'Anna',
        budget: DEFAULT_MEMBER_LIMITS,
        email: 'anna@example.com',
        createdByUserId,
        ...extra,
      });
    const storedEmail = async (userId: string) =>
      (await ctx.db.select({ email: user.email }).from(user).where(eq(user.id, userId)))[0]?.email;

    it('refuses an email change onto an address an open Invite carries, in any casing, writing nothing', async () => {
      const userId = await seedUser(ctx, 'admin@example.test');
      await createLogin(ctx.db, userId, 'this-browser');
      await createLogin(ctx.db, userId, 'an-old-phone');
      await inviteAnna(userId);

      const result = await updateListenerProfile(
        ctx.db,
        userId,
        { ...profile, name: 'Renamed', email: 'Anna@Example.com' },
        { revokeOtherLoginsExcept: 'this-browser' },
      );

      expect(result).toEqual({ ok: false, reason: 'email_has_open_invite' });
      expect(await getListenerProfile(ctx.db, userId)).toMatchObject({
        name: 'John',
        email: 'admin@example.test',
      });
      expect(await ctx.db.select({ token: session.token }).from(session)).toHaveLength(2);
    });

    it('lets the change through once the Invite is revoked, and ignores an expired one', async () => {
      const userId = await seedUser(ctx, 'admin@example.test');
      const { invite } = await inviteAnna(userId);
      await inviteAnna(userId, { expiresAt: new Date(Date.now() - 1_000) });
      await revokeInvite(ctx.db, { id: invite.id });

      const result = await updateListenerProfile(ctx.db, userId, {
        ...profile,
        email: 'anna@example.com',
      });

      expect(result).toEqual({ ok: true });
      expect(await storedEmail(userId)).toBe('anna@example.com');
    });

    it('never refuses an unchanged address or a change of casing only', async () => {
      const userId = await seedUser(ctx, 'anna@example.com');
      await inviteAnna(userId);

      expect(
        await updateListenerProfile(ctx.db, userId, { ...profile, email: 'anna@example.com' }),
      ).toEqual({ ok: true });
      expect(
        await updateListenerProfile(ctx.db, userId, { ...profile, email: 'Anna@Example.com' }),
      ).toEqual({ ok: true });
    });
  });

  describe('the owner Person following the User name', () => {
    async function saveName(userId: string, name: string): Promise<void> {
      await updateListenerProfile(ctx.db, userId, {
        name,
        email: 'admin@example.test',
        city: '',
        country: '',
        artistName: '',
        description: '',
      });
    }

    it('renames an owner Person that has never been named anything of its own', async () => {
      const userId = await seedUser(ctx, 'admin@example.test');
      const owner = await ensureOwnerPerson(ctx.db, userId);
      expect(owner.name).toBe('John');

      await saveName(userId, 'Tom');

      const [after] = await listPeople(ctx.db, userId);
      expect(after?.name).toBe('Tom');
      // The matching key travels with the name, or exact-name requests would miss.
      expect(after?.nameMatchKey).toBe(canonicalPersonName('Tom'));
    });

    it('leaves an owner Person that was deliberately named something else', async () => {
      const userId = await seedUser(ctx, 'admin@example.test');
      const owner = await ensureOwnerPerson(ctx.db, userId);
      await updatePerson(ctx.db, {
        ownerUserId: userId,
        personId: owner.id,
        name: 'DJ Thomei',
        about: 'Cropped grey hair',
      });

      await saveName(userId, 'Tom');

      const [after] = await listPeople(ctx.db, userId);
      expect(after?.name).toBe('DJ Thomei');
      expect(after?.about).toBe('Cropped grey hair');
    });

    it('keeps the Person’s own About text when the name follows', async () => {
      const userId = await seedUser(ctx, 'admin@example.test');
      const owner = await ensureOwnerPerson(ctx.db, userId);
      await updatePerson(ctx.db, {
        ownerUserId: userId,
        personId: owner.id,
        name: 'John',
        about: 'Never without headphones',
      });

      await saveName(userId, 'Tom');

      const [after] = await listPeople(ctx.db, userId);
      expect(after).toMatchObject({ name: 'Tom', about: 'Never without headphones' });
    });

    it('does not fail the profile save when the new name cannot be a Person name', async () => {
      const userId = await seedUser(ctx, 'admin@example.test');
      await ensureOwnerPerson(ctx.db, userId);
      const tooLong = 'x'.repeat(MAX_PERSON_NAME_LENGTH + 1);

      await saveName(userId, tooLong);

      expect((await getListenerProfile(ctx.db, userId))?.name).toBe(tooLong);
      expect((await listPeople(ctx.db, userId))[0]?.name).toBe('John');
    });

    it('follows the first name typed in onboarding when setup left the User nameless', async () => {
      // Setup asks for the login and nothing else, so the owner Person is provisioned
      // under the placeholder — which is still "never named anything of its own".
      const userId = randomUUID();
      await ctx.db.insert(user).values({ id: userId, name: '', email: 'admin@example.test' });
      const owner = await ensureOwnerPerson(ctx.db, userId);
      expect(owner.name).toBe(OWNER_PERSON_FALLBACK_NAME);

      await saveName(userId, 'Tom');

      expect((await listPeople(ctx.db, userId))[0]?.name).toBe('Tom');
    });

    it('leaves the owner card alone when the new name collides with another Person', async () => {
      const userId = await seedUser(ctx, 'admin@example.test');
      await ensureOwnerPerson(ctx.db, userId);
      await createPerson(ctx.db, { ownerUserId: userId, name: 'Jane', about: '' });

      await saveName(userId, 'Jane');

      const owner = (await listPeople(ctx.db, userId)).find((person) => person.role === 'owner');
      expect(owner?.name).toBe('John');
    });
  });
});
