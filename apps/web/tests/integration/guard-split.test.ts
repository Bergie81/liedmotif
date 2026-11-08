// The Member-or-Admin vs Admin-only guard split (Invite Mode),
// exercised against a real database so role and disabled state come from the
// per-request `resolveUserProfile` read — NOT from anything the session cookie
// claims. The mocked Better Auth session deliberately says nothing about role.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { user, userProfiles } from '@liedmotif/db';
import {
  connectTestDb,
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
vi.mock('@/lib/auth', () => ({
  getAuth: () => ({
    api: {
      getSession: async () =>
        holder.sessionUserId
          ? { session: { id: 'live' }, user: { id: holder.sessionUserId } }
          : null,
    },
  }),
}));

const { requireOwnerId, requireAdminOwnerId } = await import('@/lib/api-response');

/** A plain same-origin call: no `Origin` header, as a browser sends it. */
const apiRequest = () => new Request('http://localhost:2206/api/sessions', { method: 'POST' });

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

async function createProfiledUser(
  id: string,
  role: 'admin' | 'member',
  disabledAt: Date | null = null,
): Promise<string> {
  await testDb.db.insert(user).values({ id, name: id, email: `${id}@example.test` });
  await testDb.db.insert(userProfiles).values({ userId: id, role, disabledAt });
  return id;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('guard-split-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, ['user']);
  holder.sessionUserId = null;
});

describe.skipIf(skip)('API guard split', () => {
  it('requireOwnerId admits the admin and a member alike, scoped to their own id', async () => {
    const adminId = await createProfiledUser('admin-1', 'admin');
    const memberId = await createProfiledUser('member-1', 'member');

    holder.sessionUserId = adminId;
    await expect(requireOwnerId(apiRequest())).resolves.toBe(adminId);
    holder.sessionUserId = memberId;
    await expect(requireOwnerId(apiRequest())).resolves.toBe(memberId);
  });

  it('requireAdminOwnerId admits only the admin', async () => {
    const adminId = await createProfiledUser('admin-1', 'admin');
    const memberId = await createProfiledUser('member-1', 'member');

    holder.sessionUserId = adminId;
    await expect(requireAdminOwnerId(apiRequest())).resolves.toBe(adminId);
    holder.sessionUserId = memberId;
    const refusal = await requireAdminOwnerId(apiRequest());
    expect(refusal).toBeInstanceOf(NextResponse);
    expect((refusal as NextResponse).status).toBe(401);
  });

  it('both guards refuse a signed-out request and a session without a profile row', async () => {
    expect(await requireOwnerId(apiRequest())).toBeInstanceOf(NextResponse);
    expect(await requireAdminOwnerId(apiRequest())).toBeInstanceOf(NextResponse);

    await testDb.db
      .insert(user)
      .values({ id: 'stray', name: 'stray', email: 'stray@example.test' });
    holder.sessionUserId = 'stray';
    expect(await requireOwnerId(apiRequest())).toBeInstanceOf(NextResponse);
    expect(await requireAdminOwnerId(apiRequest())).toBeInstanceOf(NextResponse);
  });

  it('both guards refuse a disabled admin and a disabled member with a live cookie', async () => {
    // The mocked session stays valid throughout — only the profile row says
    // "disabled". This is the assertion that the check reads the database per
    // request rather than trusting the session payload.
    const disabledAdmin = await createProfiledUser('admin-1', 'admin', new Date());
    const disabledMember = await createProfiledUser('member-1', 'member', new Date());

    for (const id of [disabledAdmin, disabledMember]) {
      holder.sessionUserId = id;
      expect(await requireOwnerId(apiRequest())).toBeInstanceOf(NextResponse);
      expect(await requireAdminOwnerId(apiRequest())).toBeInstanceOf(NextResponse);
    }
  });

  // The CSRF second layer sits in front of the auth read: a signed-in admin is
  // exactly whose cookie a cross-site form would ride.
  it('both guards refuse a cross-origin request from a fully signed-in admin', async () => {
    const adminId = await createProfiledUser('admin-1', 'admin');
    holder.sessionUserId = adminId;
    const fromAnotherSite = new Request('http://localhost:2206/api/sessions', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });

    for (const refusal of [
      await requireOwnerId(fromAnotherSite),
      await requireAdminOwnerId(fromAnotherSite),
    ]) {
      expect(refusal).toBeInstanceOf(NextResponse);
      expect((refusal as NextResponse).status).toBe(403);
    }
  });

  it('a disable takes effect on the next request without any session change', async () => {
    const memberId = await createProfiledUser('member-1', 'member');
    holder.sessionUserId = memberId;
    await expect(requireOwnerId(apiRequest())).resolves.toBe(memberId);

    await testDb.db.update(userProfiles).set({ disabledAt: new Date() });
    expect(await requireOwnerId(apiRequest())).toBeInstanceOf(NextResponse);
  });
});
