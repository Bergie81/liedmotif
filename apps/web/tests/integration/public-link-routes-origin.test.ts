// The Origin refusal on the two unauthenticated POSTs.
//
// `/api/join/claim` and `/api/join/reset` carry no auth guard, so nothing else
// states the refusal for them — and both end in a credential the caller chose:
// a claim signs the browser into an account with the attacker's password, and a
// reset spends the one-shot link. The forged post must therefore leave the link
// unspent, which is what these assert by claiming the same token afterwards.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectTestDb,
  createUser,
  TEST_DATABASE_URL,
  truncateTables,
} from '@liedmotif/db/testing';
import type { TestDb } from '@liedmotif/db/testing';
import { createMemberInvite, createPasswordResetLink, userProfiles } from '@liedmotif/db';
import { DEFAULT_MEMBER_LIMITS } from '@liedmotif/shared';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({ getServerSession: async () => null }));
vi.mock('@/lib/auth/auth', () => ({
  getAuth: () => ({ api: { signInEmail: async () => undefined } }),
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

const { POST: claimPost } = await import('@/app/api/join/claim/route');
const { POST: resetPost } = await import('@/app/api/join/reset/route');

const PUBLIC_URL = 'https://music.example';
const skip = !TEST_DATABASE_URL;
let testDb: TestDb;
let adminId: string;

/** A POST with the given `Origin`, on a unique IP so the limiter never bites. */
function post(path: string, body: unknown, origin: string, ip: string): Request {
  return new Request(`${PUBLIC_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'x-real-ip': ip },
    body: JSON.stringify(body),
  });
}

describe.skipIf(skip)('the unauthenticated POSTs refuse a foreign Origin', () => {
  beforeAll(async () => {
    testDb = await connectTestDb('public-link-origin-test');
    holder.db = testDb.db;
  }, 60_000);
  afterAll(async () => {
    await testDb?.pool.end();
  });
  beforeEach(async () => {
    vi.stubEnv('APP_PUBLIC_URL', PUBLIC_URL);
    await truncateTables(testDb.pool, ['invites', 'user_settings', 'people', 'user']);
    adminId = await createUser(testDb.db);
    await testDb.db.insert(userProfiles).values({ userId: adminId, role: 'admin' });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses a forged claim and leaves the invite claimable', async () => {
    const { token } = await createMemberInvite(testDb.db, {
      label: 'Lisa',
      budget: DEFAULT_MEMBER_LIMITS,
      createdByUserId: adminId,
    });
    const body = {
      token,
      name: 'Lisa',
      email: 'lisa@example.test',
      password: 'Correct-Horse-42',
    };

    const forged = await claimPost(
      post('/api/join/claim', body, 'https://evil.example', '203.0.113.21'),
    );
    expect(forged.status).toBe(403);

    const own = await claimPost(post('/api/join/claim', body, PUBLIC_URL, '203.0.113.22'));
    expect(own.status).toBe(200);
  });

  it('refuses a forged reset and leaves the link spendable', async () => {
    const { token } = await createPasswordResetLink(testDb.db, {
      targetUserId: adminId,
      label: 'Admin',
      createdByUserId: adminId,
    });
    const body = { token, password: 'Correct-Horse-42' };

    const forged = await resetPost(
      post('/api/join/reset', body, 'https://evil.example', '203.0.113.23'),
    );
    expect(forged.status).toBe(403);

    const own = await resetPost(post('/api/join/reset', body, PUBLIC_URL, '203.0.113.24'));
    expect(own.status).toBe(200);
  });
});
