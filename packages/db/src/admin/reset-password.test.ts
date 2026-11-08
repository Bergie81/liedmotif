import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { account, userProfiles, user } from '../schema';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { createLogin, liveLoginOwnerIds } from '../generation/test-fixtures';
import { AdminNotFoundError, WeakPasswordError, resetAdminPassword } from './reset-password';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

// Better Auth's crypto is nested under @liedmotif/db's node_modules; load it at
// runtime (a dynamic import resolves from this file's location) so it works under
// the repo-root test runner.
type Crypto = {
  hashPassword: (password: string) => Promise<string>;
  verifyPassword: (args: { hash: string; password: string }) => Promise<boolean>;
};
let crypto: Crypto;

/** Seed a user (user + user_profiles + credential account) with a known password. */
async function seedUser(
  ctx: TestDb,
  role: 'admin' | 'member',
  email: string,
  password: string,
): Promise<string> {
  const userId = randomUUID();
  await ctx.db
    .insert(user)
    .values({ id: userId, name: role === 'admin' ? 'Admin' : 'Member', email });
  await ctx.db.insert(userProfiles).values({ userId, role });
  await ctx.db.insert(account).values({
    id: randomUUID(),
    accountId: userId,
    providerId: 'credential',
    userId,
    password: await crypto.hashPassword(password),
  });
  return userId;
}

const seedAdmin = (ctx: TestDb, email: string, password: string) =>
  seedUser(ctx, 'admin', email, password);

/** Read the stored credential-account password hash for a user. */
async function storedHash(ctx: TestDb, userId: string): Promise<string | null | undefined> {
  const rows = await ctx.db.select().from(account);
  return rows.find((row) => row.userId === userId && row.providerId === 'credential')?.password;
}

describeIfDb('resetAdminPassword (no-email recovery)', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-reset-test');
    crypto = (await import('better-auth/crypto')) as unknown as Crypto;
  }, 60_000);

  afterAll(async () => {
    await ctx?.pool.end();
  });

  beforeEach(async () => {
    await truncateTables(ctx.pool, ['user']);
  });

  it('rotates the admin password so the new one verifies and the old does not', async () => {
    const userId = await seedAdmin(ctx, 'admin@example.test', 'old-password-123');

    const out = await resetAdminPassword(ctx.db, {
      email: 'admin@example.test',
      newPassword: 'Brand-New-Password-456',
    });
    expect(out.userId).toBe(userId);

    const hash = await storedHash(ctx, userId);
    expect(hash).toBeTruthy();
    expect(await crypto.verifyPassword({ hash: hash!, password: 'Brand-New-Password-456' })).toBe(
      true,
    );
    expect(await crypto.verifyPassword({ hash: hash!, password: 'old-password-123' })).toBe(false);
  });

  it('targets the single admin when no email is given', async () => {
    const userId = await seedAdmin(ctx, 'solo-admin@example.test', 'old-password-123');
    const out = await resetAdminPassword(ctx.db, { newPassword: 'Replacement-Pass-789' });
    expect(out.userId).toBe(userId);
    expect(out.email).toBe('solo-admin@example.test');
  });

  it('rejects a password that misses the policy, naming the unmet rule', async () => {
    await seedAdmin(ctx, 'admin@example.test', 'old-password-123');
    await expect(
      resetAdminPassword(ctx.db, { email: 'admin@example.test', newPassword: 'short' }),
    ).rejects.toBeInstanceOf(WeakPasswordError);
    await expect(
      resetAdminPassword(ctx.db, { email: 'admin@example.test', newPassword: 'lowercase-pass-1' }),
    ).rejects.toThrow(/uppercase/i);
  });

  it('throws when no admin exists', async () => {
    await expect(
      resetAdminPassword(ctx.db, { newPassword: 'A-valid-password-1' }),
    ).rejects.toBeInstanceOf(AdminNotFoundError);
  });

  it('throws when the email does not match the admin', async () => {
    await seedAdmin(ctx, 'admin@example.test', 'old-password-123');
    await expect(
      resetAdminPassword(ctx.db, {
        email: 'nobody@example.test',
        newPassword: 'A-valid-password-1',
      }),
    ).rejects.toBeInstanceOf(AdminNotFoundError);
  });

  it('creates a credential account when one is missing', async () => {
    const userId = randomUUID();
    await ctx.db
      .insert(user)
      .values({ id: userId, name: 'Admin', email: 'noaccount@example.test' });
    await ctx.db.insert(userProfiles).values({ userId, role: 'admin' });

    await resetAdminPassword(ctx.db, {
      email: 'noaccount@example.test',
      newPassword: 'Fresh-Account-Pass-1',
    });

    const hash = await storedHash(ctx, userId);
    expect(hash).toBeTruthy();
    expect(await crypto.verifyPassword({ hash: hash!, password: 'Fresh-Account-Pass-1' })).toBe(
      true,
    );
  });

  // `user_profiles` holds BOTH roles since Invite Mode. This
  // admin-only recovery path must not see Members at all: not as a target, and
  // not as extra rows that make the single admin ambiguous.
  it('ignores Members when resolving the single admin with no email', async () => {
    const adminId = await seedAdmin(ctx, 'admin@example.test', 'old-password-123');
    await seedUser(ctx, 'member', 'member@example.test', 'member-password-123');

    const out = await resetAdminPassword(ctx.db, { newPassword: 'Brand-New-Password-456' });

    expect(out.userId).toBe(adminId);
    expect(out.email).toBe('admin@example.test');
  });

  it('refuses to rotate a Member password through the admin recovery path', async () => {
    await seedAdmin(ctx, 'admin@example.test', 'old-password-123');
    const memberId = await seedUser(ctx, 'member', 'member@example.test', 'member-password-123');
    const before = await storedHash(ctx, memberId);

    await expect(
      resetAdminPassword(ctx.db, {
        email: 'member@example.test',
        newPassword: 'Brand-New-Password-456',
      }),
    ).rejects.toBeInstanceOf(AdminNotFoundError);
    expect(await storedHash(ctx, memberId)).toBe(before);
  });

  // Recovery has to evict a session thief: rotating the credential is useless
  // while the stolen cookie's Login row still exists.
  it('revokes the admin’s live Logins, and only theirs', async () => {
    const adminId = await seedAdmin(ctx, 'admin@example.test', 'old-password-123');
    const memberId = await seedUser(ctx, 'member', 'member@example.test', 'member-password-123');
    await createLogin(ctx.db, adminId);
    await createLogin(ctx.db, adminId);
    await createLogin(ctx.db, memberId);

    await resetAdminPassword(ctx.db, {
      email: 'admin@example.test',
      newPassword: 'Brand-New-Password-456',
    });

    expect(await liveLoginOwnerIds(ctx.db)).toEqual([memberId]);
  });

  it('leaves live Logins intact when the reset is refused', async () => {
    await seedAdmin(ctx, 'admin@example.test', 'old-password-123');
    const memberId = await seedUser(ctx, 'member', 'member@example.test', 'member-password-123');
    await createLogin(ctx.db, memberId);

    await expect(
      resetAdminPassword(ctx.db, {
        email: 'member@example.test',
        newPassword: 'Brand-New-Password-456',
      }),
    ).rejects.toBeInstanceOf(AdminNotFoundError);

    expect(await liveLoginOwnerIds(ctx.db)).toEqual([memberId]);
  });

  it('returns only non-secret fields (never the password)', async () => {
    await seedAdmin(ctx, 'admin@example.test', 'old-password-123');
    const out = await resetAdminPassword(ctx.db, {
      email: 'admin@example.test',
      newPassword: 'Brand-New-Password-456',
    });
    expect(Object.keys(out).sort()).toEqual(['email', 'userId']);
    expect(JSON.stringify(out)).not.toContain('Brand-New-Password-456');
  });
});
