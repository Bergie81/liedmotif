// POST /api/join/claim: the unauthenticated claim endpoint.
// Opaque refusals, no account swap under a signed-in user, sign-in on success.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  connectTestDb,
  createUser,
  TEST_DATABASE_URL,
  truncateTables,
} from '@liedmotif/db/testing';
import type { TestDb } from '@liedmotif/db/testing';
import { createMemberInvite, invites, revokeInvite, user, userProfiles } from '@liedmotif/db';
import { DEFAULT_MEMBER_LIMITS } from '@liedmotif/shared';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  signedIn: false,
  signInCalls: [] as Array<{ email: string; password: string }>,
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getServerSession: async () => (holder.signedIn ? { user: { id: 'someone' } } : null),
}));
vi.mock('@/lib/auth/auth', () => ({
  getAuth: () => ({
    api: {
      signInEmail: async ({ body }: { body: { email: string; password: string } }) => {
        holder.signInCalls.push(body);
      },
    },
  }),
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

const { POST } = await import('@/app/api/join/claim/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;
let adminId: string;

function postClaim(body: Record<string, unknown>, ip = '203.0.113.7') {
  return POST(
    new Request('http://localhost/api/join/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': ip },
      body: JSON.stringify(body),
    }),
  );
}

describe.skipIf(skip)('POST /api/join/claim', () => {
  beforeAll(async () => {
    testDb = await connectTestDb('join-claim-route-test');
    holder.db = testDb.db;
  }, 60_000);
  afterAll(async () => {
    await testDb?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(testDb.pool, ['invites', 'user_settings', 'people', 'user']);
    holder.signedIn = false;
    holder.signInCalls = [];
    adminId = await createUser(testDb.db);
    await testDb.db.insert(userProfiles).values({ userId: adminId, role: 'admin' });
  });

  async function mint() {
    return createMemberInvite(testDb.db, {
      label: 'Lisa',
      budget: DEFAULT_MEMBER_LIMITS,
      createdByUserId: adminId,
    });
  }

  it('creates the Member and signs them in', async () => {
    const { token } = await mint();
    const response = await postClaim({
      token,
      name: 'Lisa',
      email: 'lisa@example.test',
      password: 'Correct-Horse-42',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { signedIn: true } });
    expect(holder.signInCalls).toEqual([
      { email: 'lisa@example.test', password: 'Correct-Horse-42' },
    ]);

    const members = await testDb.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.role, 'member'));
    expect(members).toHaveLength(1);
  });

  it('answers a spent token with the opaque refusal and no partial account', async () => {
    const { token } = await mint();
    await postClaim({
      token,
      name: 'Lisa',
      email: 'lisa@example.test',
      password: 'Correct-Horse-42',
    });

    const replay = await postClaim({
      token,
      name: 'Eve',
      email: 'eve@example.test',
      password: 'Correct-Horse-42',
    });
    expect(replay.status).toBe(404);
    const body = await replay.json();
    expect(body.error.message).toBe('This link is no longer valid.');

    const unknown = await postClaim({
      token: 'never-existed',
      name: 'Eve',
      email: 'eve@example.test',
      password: 'Correct-Horse-42',
    });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.message).toBe(body.error.message);

    const members = await testDb.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.role, 'member'));
    expect(members).toHaveLength(1);
  });

  it('a revoked token gets the same refusal as an unknown one', async () => {
    const { token, invite } = await mint();
    await revokeInvite(testDb.db, { id: invite.id });
    const response = await postClaim({
      token,
      name: 'Lisa',
      email: 'lisa@example.test',
      password: 'Correct-Horse-42',
    });
    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe('This link is no longer valid.');
  });

  it('refuses a signed-in caller instead of swapping the account', async () => {
    holder.signedIn = true;
    const { token } = await mint();
    const response = await postClaim({
      token,
      name: 'Lisa',
      email: 'lisa@example.test',
      password: 'Correct-Horse-42',
    });
    expect(response.status).toBe(409);
    expect(holder.signInCalls).toHaveLength(0);
    const members = await testDb.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.role, 'member'));
    expect(members).toHaveLength(0);
  });

  it('rejects a weak password with the policy message and creates nothing', async () => {
    const { token } = await mint();
    const response = await postClaim({
      token,
      name: 'Lisa',
      email: 'lisa@example.test',
      password: 'weak-horse',
    });
    expect(response.status).toBe(400);
    const message = (await response.json()).error.message as string;
    expect(message).toMatch(/number/i);
    expect(message).toMatch(/uppercase/i);

    expect(holder.signInCalls).toHaveLength(0);
    const members = await testDb.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.role, 'member'));
    expect(members).toHaveLength(0);
  });

  it('surfaces a duplicate email as a clean validation error', async () => {
    const first = await mint();
    await postClaim({
      token: first.token,
      name: 'Lisa',
      email: 'lisa@example.test',
      password: 'Correct-Horse-42',
    });
    const second = await mint();
    const response = await postClaim({
      token: second.token,
      name: 'Lisa II',
      email: 'lisa@example.test',
      password: 'Correct-Horse-42',
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain('already in use');
  });

  // The emailed Invite's address is fixed, so its claimer cannot pick another:
  // only the Admin can help, with a new Invite.
  it('tells the claimer of an emailed Invite whose address is taken to ask for a new one, creating nothing', async () => {
    await testDb.db
      .insert(user)
      .values({ id: 'holder-1', name: 'Anna', email: 'anna@example.com' });
    const bound = await createMemberInvite(testDb.db, {
      label: 'Anna',
      budget: DEFAULT_MEMBER_LIMITS,
      email: 'anna@example.com',
      createdByUserId: adminId,
    });

    const response = await postClaim({
      token: bound.token,
      name: 'Anna',
      email: 'anna@example.com',
      password: 'Correct-Horse-42',
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe(
      'Someone already signs in with this invite’s address. Ask your admin for a new invite.',
    );
    expect(holder.signInCalls).toEqual([]);
    const members = await testDb.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.role, 'member'));
    expect(members).toEqual([]);
    const [inviteRow] = await testDb.db
      .select({ consumedAt: invites.consumedAt })
      .from(invites)
      .where(eq(invites.id, bound.invite.id));
    expect(inviteRow?.consumedAt).toBeNull();
  });

  it('throttles by IP', async () => {
    const ip = '198.51.100.42';
    let lastStatus = 0;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await postClaim(
        { token: 'x', name: 'X', email: 'x@example.test', password: 'Correct-Horse-42' },
        ip,
      );
      lastStatus = response.status;
    }
    expect(lastStatus).toBe(429);
  });
});
