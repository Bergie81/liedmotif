// The sign-in email lock: only the Admin moves
// their own sign-in address. Against a real database, so the role the route
// decides on comes from the profile row, never from the request or the cookie.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { defaultHashPassword, upsertCredentialPassword, user, userProfiles } from '@liedmotif/db';
import {
  connectTestDb,
  createLogin,
  liveLoginOwnerIds,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionUserId: null as string | null,
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/auth', () => ({
  getAuth: () => ({
    api: {
      getSession: async () =>
        holder.sessionUserId
          ? {
              session: { token: `this-browser-${holder.sessionUserId}` },
              user: { id: holder.sessionUserId },
            }
          : null,
    },
  }),
}));

const { POST } = await import('@/app/api/settings/profile/route');

const PASSWORD = 'Correct-Horse-42';
const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

/** A User of `role` with a credential password and two Logins: this browser and another. */
async function createAccount(id: string, role: 'admin' | 'member'): Promise<string> {
  await testDb.db.insert(user).values({ id, name: 'Lisa', email: `${id}@example.test` });
  await testDb.db.insert(userProfiles).values({ userId: id, role });
  await upsertCredentialPassword(testDb.db, id, await defaultHashPassword(PASSWORD));
  await createLogin(testDb.db, id, `this-browser-${id}`);
  await createLogin(testDb.db, id, `other-browser-${id}`);
  return id;
}

function save(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request('http://localhost/api/settings/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Lisa', city: '', country: '', artistName: '', ...body }),
    }),
  );
}

async function storedUser(id: string) {
  const [row] = await testDb.db
    .select({ name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, id));
  return row;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('member-email-lock-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  // Account email off: the lock holds in both modes.
  vi.stubEnv('SMTP_URL', '');
  vi.stubEnv('MAIL_FROM', '');
  await truncateTables(testDb.pool, ['user']);
  holder.sessionUserId = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.skipIf(skip)('POST /api/settings/profile — sign-in email lock', () => {
  it('refuses a Member’s email change even with the right password, and writes nothing', async () => {
    holder.sessionUserId = await createAccount('member-1', 'member');

    const response = await save({
      name: 'Renamed',
      email: 'elsewhere@example.test',
      currentPassword: PASSWORD,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Your sign-in email can’t be changed.',
    });
    expect(await storedUser('member-1')).toEqual({
      name: 'Lisa',
      email: 'member-1@example.test',
    });
    expect(await liveLoginOwnerIds(testDb.db)).toEqual(['member-1', 'member-1']);
  });

  // Sign-in looks the address up lowercased and compares it exactly, so a
  // casing-only rewrite of the stored address would lock the account out.
  it('saves a Member’s other fields when the email is the same in any casing, address untouched', async () => {
    holder.sessionUserId = await createAccount('member-1', 'member');

    const response = await save({ name: 'Renamed', email: 'Member-1@Example.TEST' });

    expect(response.status).toBe(200);
    expect(await storedUser('member-1')).toEqual({
      name: 'Renamed',
      email: 'member-1@example.test',
    });
    expect(await liveLoginOwnerIds(testDb.db)).toEqual(['member-1', 'member-1']);
  });

  it('saves the Admin’s password-confirmed email change and signs out their other Logins', async () => {
    holder.sessionUserId = await createAccount('admin-1', 'admin');
    await createAccount('member-1', 'member');

    const response = await save({ email: 'new@example.test', currentPassword: PASSWORD });

    expect(response.status).toBe(200);
    expect((await storedUser('admin-1'))?.email).toBe('new@example.test');
    // This browser keeps its Login; the Member's are not the Admin's to revoke.
    expect(await liveLoginOwnerIds(testDb.db)).toEqual(['admin-1', 'member-1', 'member-1']);
  });

  it('refuses the Admin’s move to an address another account signs in with, and changes nothing', async () => {
    holder.sessionUserId = await createAccount('admin-1', 'admin');
    await createAccount('member-1', 'member');

    const response = await save({
      name: 'Renamed',
      email: 'Member-1@Example.TEST',
      currentPassword: PASSWORD,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'That email is already in use. Pick another.',
    });
    expect(await storedUser('admin-1')).toEqual({ name: 'Lisa', email: 'admin-1@example.test' });
    expect(await liveLoginOwnerIds(testDb.db)).toEqual([
      'admin-1',
      'admin-1',
      'member-1',
      'member-1',
    ]);
  });

  // Sign-in lowercases the typed address and compares it exactly with the
  // stored one, so an address stored as typed would lock the Admin out.
  it('stores the Admin’s new address lowercased', async () => {
    holder.sessionUserId = await createAccount('admin-1', 'admin');

    const response = await save({ email: 'New@Example.TEST', currentPassword: PASSWORD });

    expect(response.status).toBe(200);
    expect((await storedUser('admin-1'))?.email).toBe('new@example.test');
  });
});
