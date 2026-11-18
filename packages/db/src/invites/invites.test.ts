// Invites: one-shot hashed tokens and the atomic Member claim.
//
// The claim is one transaction: conditionally consume the invite, create the
// Better Auth user + credential account, create the member profile, snapshot
// the budget. Everything here runs against real Postgres because the whole
// point is race-safety and rollback behavior.

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MEMBER_LIMITS, type MemberLimits } from '@liedmotif/shared';
import { and, eq } from 'drizzle-orm';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { createLogin, createUser, liveLoginOwnerIds } from '../generation/test-fixtures';
import { account, invites, people, user, userProfiles } from '../schema';
import { getMemberLimits } from '../settings/user-settings-repo';
import { countAdmins } from '../setup/state';
import {
  claimMemberInvite,
  createMemberInvite,
  createPasswordResetLink,
  listOpenMemberInvites,
  findClaimableLink,
  resetPasswordWithToken,
  revokeInvite,
} from './index';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

/** Fast injectable hasher — scrypt correctness belongs to Better Auth. */
const fakeHash = async (password: string): Promise<string> => `fake-hash(${password})`;

const CUSTOM_BUDGET: MemberLimits = {
  ...DEFAULT_MEMBER_LIMITS,
  dailyGenerationTasks: 3,
  monthlyGenerationTasks: 30,
};

describeIfDb('invites — one-shot tokens and the atomic Member claim', () => {
  let ctx: TestDb;
  let adminId: string;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-invites-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, ['invites', 'user_settings', 'people', 'user']);
    adminId = await createUser(ctx.db);
    await ctx.db.insert(userProfiles).values({ userId: adminId, role: 'admin' });
  });

  async function mintInvite(budget: MemberLimits = CUSTOM_BUDGET) {
    return createMemberInvite(ctx.db, {
      label: 'Lisa',
      budget,
      createdByUserId: adminId,
    });
  }

  it('claiming a valid invite creates exactly one Member with budget, owner Person, consumed invite', async () => {
    const { token, invite } = await mintInvite();

    const result = await claimMemberInvite(ctx.db, {
      token,
      name: 'Lisa',
      email: 'Lisa@Example.test',
      password: 'correct-horse',
      hashPassword: fakeHash,
    });
    expect(result).toMatchObject({ ok: true, email: 'lisa@example.test' });
    if (!result.ok) return;

    const [memberUser] = await ctx.db.select().from(user).where(eq(user.id, result.userId));
    expect(memberUser?.email).toBe('lisa@example.test');
    expect(memberUser?.name).toBe('Lisa');

    const [profile] = await ctx.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, result.userId));
    expect(profile?.role).toBe('member');
    expect(profile?.disabledAt).toBeNull();

    expect(await getMemberLimits(ctx.db, result.userId)).toEqual(CUSTOM_BUDGET);

    const [ownerPerson] = await ctx.db
      .select()
      .from(people)
      .where(and(eq(people.ownerUserId, result.userId), eq(people.role, 'owner')));
    expect(ownerPerson?.name).toBe('Lisa');

    const [consumed] = await ctx.db.select().from(invites).where(eq(invites.id, invite.id));
    expect(consumed?.consumedAt).not.toBeNull();
    expect(consumed?.consumedByUserId).toBe(result.userId);
  });

  it('claiming a One-time invite stamps the Grant at claim time, not at mint time', async () => {
    const { token } = await mintInvite({
      ...CUSTOM_BUDGET,
      kind: 'oneTime',
      grantedAt: '2026-01-01T00:00:00.000Z',
    });
    const now = new Date('2026-09-12T10:00:00.000Z');
    const result = await claimMemberInvite(ctx.db, {
      token,
      name: 'Lisa',
      email: 'lisa@example.test',
      password: 'correct-horse',
      hashPassword: fakeHash,
      now,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await getMemberLimits(ctx.db, result.userId)).toEqual({
      ...CUSTOM_BUDGET,
      kind: 'oneTime',
      grantedAt: now.toISOString(),
    });
  });

  it('two concurrent claims of the same token create exactly one Member', async () => {
    const { token } = await mintInvite();
    const claim = (email: string) =>
      claimMemberInvite(ctx.db, {
        token,
        name: 'Racer',
        email,
        password: 'correct-horse',
        hashPassword: fakeHash,
      });

    const [a, b] = await Promise.all([claim('a@example.test'), claim('b@example.test')]);
    const outcomes = [a.ok, b.ok].sort();
    expect(outcomes).toEqual([false, true]);
    const loser = a.ok ? b : a;
    expect(loser).toEqual({ ok: false, reason: 'invalid_token' });

    const members = await ctx.db.select().from(userProfiles).where(eq(userProfiles.role, 'member'));
    expect(members).toHaveLength(1);
  });

  it('expired, revoked, consumed, and unknown tokens all fail identically', async () => {
    const claimWith = (token: string) =>
      claimMemberInvite(ctx.db, {
        token,
        name: 'X',
        email: `x-${token.slice(0, 6)}@example.test`,
        password: 'correct-horse',
        hashPassword: fakeHash,
      });

    const expired = await createMemberInvite(ctx.db, {
      label: 'Old',
      budget: CUSTOM_BUDGET,
      createdByUserId: adminId,
      expiresAt: new Date(Date.now() - 1_000),
    });
    const revoked = await mintInvite();
    expect(await revokeInvite(ctx.db, { id: revoked.invite.id })).toBe(true);
    const consumed = await mintInvite();
    await claimWith(consumed.token);

    const refusal = { ok: false, reason: 'invalid_token' };
    expect(await claimWith(expired.token)).toEqual(refusal);
    expect(await claimWith(revoked.token)).toEqual(refusal);
    expect(await claimWith(consumed.token)).toEqual(refusal);
    expect(await claimWith('completely-unknown-token')).toEqual(refusal);
  });

  it('stores only the SHA-256 of the token — the plaintext is not recoverable from the row', async () => {
    const { token, invite } = await mintInvite();
    const [row] = await ctx.db.select().from(invites).where(eq(invites.id, invite.id));
    expect(row?.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(row?.tokenHash).not.toBe(token);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('refuses a duplicate email with no partial rows, leaving the invite claimable', async () => {
    const first = await mintInvite();
    await claimMemberInvite(ctx.db, {
      token: first.token,
      name: 'Lisa',
      email: 'lisa@example.test',
      password: 'correct-horse',
      hashPassword: fakeHash,
    });

    const second = await mintInvite();
    const duplicate = await claimMemberInvite(ctx.db, {
      token: second.token,
      name: 'Imposter',
      email: 'LISA@example.test',
      password: 'correct-horse',
      hashPassword: fakeHash,
    });
    expect(duplicate).toEqual({ ok: false, reason: 'email_in_use' });

    // No partial user row, and the invite rolled back to claimable.
    const users = await ctx.db.select().from(user).where(eq(user.email, 'lisa@example.test'));
    expect(users).toHaveLength(1);
    const [inviteRow] = await ctx.db.select().from(invites).where(eq(invites.id, second.invite.id));
    expect(inviteRow?.consumedAt).toBeNull();

    const retry = await claimMemberInvite(ctx.db, {
      token: second.token,
      name: 'Sam',
      email: 'sam@example.test',
      password: 'correct-horse',
      hashPassword: fakeHash,
    });
    expect(retry.ok).toBe(true);
  });

  // The address of an emailed Invite is fixed, so "pick another" is advice its
  // claimer cannot follow: the result tells the route which case it is.
  it('refuses an emailed Invite whose address a User already holds, with no partial rows, leaving it claimable', async () => {
    await ctx.db.insert(user).values({ id: 'holder-1', name: 'Anna', email: 'anna@example.com' });
    const bound = await createMemberInvite(ctx.db, {
      label: 'Anna',
      budget: CUSTOM_BUDGET,
      email: 'anna@example.com',
      createdByUserId: adminId,
    });

    const result = await claimMemberInvite(ctx.db, {
      token: bound.token,
      name: 'Anna',
      email: 'someone-else@example.test',
      password: 'correct-horse',
      hashPassword: fakeHash,
    });

    expect(result).toEqual({ ok: false, reason: 'invite_email_in_use' });
    const users = await ctx.db.select().from(user).where(eq(user.email, 'anna@example.com'));
    expect(users.map((row) => row.id)).toEqual(['holder-1']);
    const [inviteRow] = await ctx.db.select().from(invites).where(eq(invites.id, bound.invite.id));
    expect(inviteRow?.consumedAt).toBeNull();
  });

  it('claiming an emailed Invite signs in with its address, confirmed, whatever the body says', async () => {
    const { token } = await createMemberInvite(ctx.db, {
      label: 'Lisa',
      budget: CUSTOM_BUDGET,
      email: 'Lisa@Example.test',
      createdByUserId: adminId,
    });

    const result = await claimMemberInvite(ctx.db, {
      token,
      name: 'Lisa',
      email: 'someone-else@example.test',
      password: 'correct-horse',
      hashPassword: fakeHash,
    });

    expect(result).toMatchObject({ ok: true, email: 'lisa@example.test' });
    if (!result.ok) return;
    const [member] = await ctx.db.select().from(user).where(eq(user.id, result.userId));
    expect(member).toMatchObject({ email: 'lisa@example.test', emailVerified: true });
  });

  it('claiming a copy-link Invite keeps the chosen address, unconfirmed', async () => {
    const { token } = await mintInvite();

    const result = await claimMemberInvite(ctx.db, {
      token,
      name: 'Lisa',
      email: 'lisa@example.test',
      password: 'correct-horse',
      hashPassword: fakeHash,
    });

    if (!result.ok) throw new Error('claim refused');
    const [member] = await ctx.db.select().from(user).where(eq(user.id, result.userId));
    expect(member).toMatchObject({ email: 'lisa@example.test', emailVerified: false });
  });

  it('the claim path can never mint an admin', async () => {
    const { token } = await mintInvite();
    const result = await claimMemberInvite(ctx.db, {
      token,
      name: 'Lisa',
      email: 'lisa@example.test',
      password: 'correct-horse',
      hashPassword: fakeHash,
    });
    expect(result.ok).toBe(true);
    expect(await countAdmins(ctx.db)).toBe(1);
  });

  it('hashes the password with the real hasher by default — never stored plaintext', async () => {
    const { token } = await mintInvite();
    const result = await claimMemberInvite(ctx.db, {
      token,
      name: 'Lisa',
      email: 'lisa@example.test',
      password: 'correct-horse-battery',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [credential] = await ctx.db
      .select()
      .from(account)
      .where(eq(account.userId, result.userId));
    expect(credential?.password).toBeTruthy();
    expect(credential?.password).not.toContain('correct-horse-battery');
  });

  it('lists open invites and drops revoked/consumed/expired ones', async () => {
    const open = await mintInvite();
    const revoked = await mintInvite();
    await revokeInvite(ctx.db, { id: revoked.invite.id });
    await createMemberInvite(ctx.db, {
      label: 'Expired',
      budget: CUSTOM_BUDGET,
      createdByUserId: adminId,
      expiresAt: new Date(Date.now() - 1_000),
    });

    const listed = await listOpenMemberInvites(ctx.db);
    expect(listed.map((row) => row.id)).toEqual([open.invite.id]);
    expect(listed[0]?.label).toBe('Lisa');
  });

  it('finds a claimable invite by plaintext token, for the claim page', async () => {
    const { token } = await mintInvite();
    expect(await findClaimableLink(ctx.db, { kind: 'member_invite', token: 'nope' })).toBeNull();
    expect((await findClaimableLink(ctx.db, { kind: 'member_invite', token }))?.label).toBe('Lisa');
  });

  it('a password-reset link rotates the credential exactly once', async () => {
    const { token } = await mintInvite();
    const claimed = await claimMemberInvite(ctx.db, {
      token,
      name: 'Lisa',
      email: 'lisa@example.test',
      password: 'first-password',
      hashPassword: fakeHash,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    const reset = await createPasswordResetLink(ctx.db, {
      targetUserId: claimed.userId,
      label: 'Lisa',
      createdByUserId: adminId,
    });
    const rotated = await resetPasswordWithToken(ctx.db, {
      token: reset.token,
      newPassword: 'second-password',
      hashPassword: fakeHash,
    });
    expect(rotated).toEqual({ ok: true, userId: claimed.userId });

    const [credential] = await ctx.db
      .select()
      .from(account)
      .where(eq(account.userId, claimed.userId));
    expect(credential?.password).toBe('fake-hash(second-password)');

    const replay = await resetPasswordWithToken(ctx.db, {
      token: reset.token,
      newPassword: 'third-password',
      hashPassword: fakeHash,
    });
    expect(replay).toEqual({ ok: false, reason: 'invalid_token' });
  });

  // Recovery has to evict a session thief: rotating the credential is useless
  // while the stolen cookie's Login row still exists.
  it('a spent reset link revokes the target user’s live Logins, and only theirs', async () => {
    const { token } = await mintInvite();
    const claimed = await claimMemberInvite(ctx.db, {
      token,
      name: 'Lisa',
      email: 'lisa@example.test',
      password: 'first-password',
      hashPassword: fakeHash,
    });
    if (!claimed.ok) throw new Error('claim failed');
    await createLogin(ctx.db, claimed.userId);
    await createLogin(ctx.db, claimed.userId);
    await createLogin(ctx.db, adminId);

    const reset = await createPasswordResetLink(ctx.db, {
      targetUserId: claimed.userId,
      label: 'Lisa',
      createdByUserId: adminId,
    });
    await resetPasswordWithToken(ctx.db, {
      token: reset.token,
      newPassword: 'second-password',
      hashPassword: fakeHash,
    });

    expect(await liveLoginOwnerIds(ctx.db)).toEqual([adminId]);
  });

  it('a dead reset token leaves both the credential and the live Logins intact', async () => {
    await createLogin(ctx.db, adminId);

    expect(
      await resetPasswordWithToken(ctx.db, {
        token: 'not-a-real-token',
        newPassword: 'second-password',
        hashPassword: fakeHash,
      }),
    ).toEqual({ ok: false, reason: 'invalid_token' });

    expect(await liveLoginOwnerIds(ctx.db)).toEqual([adminId]);
  });

  it('a member-invite token cannot be spent as a password reset, nor vice versa', async () => {
    const { token } = await mintInvite();
    expect(
      await resetPasswordWithToken(ctx.db, {
        token,
        newPassword: 'sneaky-password',
        hashPassword: fakeHash,
      }),
    ).toEqual({ ok: false, reason: 'invalid_token' });

    const reset = await createPasswordResetLink(ctx.db, {
      targetUserId: adminId,
      label: 'Admin',
      createdByUserId: adminId,
    });
    expect(
      await claimMemberInvite(ctx.db, {
        token: reset.token,
        name: 'X',
        email: 'x@example.test',
        password: 'correct-horse',
        hashPassword: fakeHash,
      }),
    ).toEqual({ ok: false, reason: 'invalid_token' });
  });
});
