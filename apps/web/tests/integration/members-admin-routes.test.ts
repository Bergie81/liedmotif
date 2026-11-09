// Members administration: invite minting/revoking, one-shot
// password-reset links, the immediate reversible disable, and the aggregate-only
// page payload (its exact shape is pinned so a future field cannot quietly
// leak content).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createUser,
  TEST_DATABASE_URL,
  truncateTables,
} from '@liedmotif/db/testing';
import type { TestDb } from '@liedmotif/db/testing';
import {
  claimMemberInvite,
  getMemberLimits,
  resolveUserProfile,
  session as sessionTable,
  userProfiles,
} from '@liedmotif/db';

const holder = vi.hoisted(() => ({ db: null as unknown, adminId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.adminId ? { user: { id: holder.adminId } } : null),
  getAppSession: async () => (holder.adminId ? { user: { id: holder.adminId } } : null),
  getServerSession: async () => null,
}));
vi.mock('@/lib/providers', () => ({ getTypicalTracksPerMusicRequest: () => 2 }));

process.env.APP_PUBLIC_URL = 'https://192.168.1.10';

const { POST: createInvitePost, GET: listInvitesGet } =
  await import('@/app/api/settings/members/invites/route');
const { DELETE: revokeInviteDelete } =
  await import('@/app/api/settings/members/invites/[inviteId]/route');
const { POST: resetPasswordPost } =
  await import('@/app/api/settings/members/[userId]/reset-password/route');
const { POST: disabledPost } = await import('@/app/api/settings/members/[userId]/disabled/route');
const { POST: joinResetPost } = await import('@/app/api/join/reset/route');
const { POST: limitsPost } = await import('@/app/api/settings/members/[userId]/limits/route');
const { loadMembersAdminData } = await import('@/lib/members-admin-data');

/** A same-origin API call: the guards look only at the absent `Origin`. */
const apiRequest = () => new Request('http://localhost/api');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

const fakeHash = async (password: string): Promise<string> => `fake-hash(${password})`;

function jsonRequest(url: string, method: string, body?: unknown, ip = '203.0.113.9') {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function mintInvite(label = 'Lisa', budget?: Record<string, unknown>) {
  const response = await createInvitePost(
    jsonRequest('http://localhost/api/settings/members/invites', 'POST', { label, budget }),
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  return body.data as { url: string; invite: { id: string; label: string } };
}

async function claimAsMember(url: string, email: string, now?: Date) {
  const token = url.split('/join/')[1]!;
  const result = await claimMemberInvite(testDb.db, {
    token,
    name: 'Lisa',
    email,
    password: 'correct-horse',
    hashPassword: fakeHash,
    now,
  });
  expect(result.ok).toBe(true);
  return result.ok ? result.userId : '';
}

/** One spent provider task for `ownerUserId` at `createdAt`. */
async function spendTask(ownerUserId: string, createdAt: Date): Promise<void> {
  const generationRequestId = await createGenerationRequest(testDb.db, { ownerUserId, createdAt });
  await createProviderJob(testDb.db, { generationRequestId, createdAt });
}

describe.skipIf(skip)('Settings → Members administration routes', () => {
  beforeAll(async () => {
    testDb = await connectTestDb('members-admin-routes-test');
    holder.db = testDb.db;
  }, 60_000);
  afterAll(async () => {
    await testDb?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(testDb.pool, [
      'invites',
      'user_settings',
      'people',
      'session',
      'app_settings',
      'provider_jobs',
      'generation_requests',
      'user',
    ]);
    holder.adminId = await createUser(testDb.db);
    await testDb.db.insert(userProfiles).values({ userId: holder.adminId, role: 'admin' });
    // The copy-link flows; `.env` may turn account email on for development.
    vi.stubEnv('SMTP_URL', '');
    vi.stubEnv('MAIL_FROM', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('mints an invite whose URL uses APP_PUBLIC_URL verbatim — private IP included', async () => {
    const { url, invite } = await mintInvite('Lisa');
    expect(url).toMatch(/^https:\/\/192\.168\.1\.10\/join\/[A-Za-z0-9_-]{20,}$/);
    expect(invite.label).toBe('Lisa');

    const listed = await (await listInvitesGet(apiRequest())).json();
    expect(listed.data.invites.map((row: { id: string }) => row.id)).toEqual([invite.id]);
  });

  it('revoking makes the token unclaimable and empties the open list', async () => {
    const { url, invite } = await mintInvite();
    const revoke = await revokeInviteDelete(
      jsonRequest(`http://localhost/api/settings/members/invites/${invite.id}`, 'DELETE'),
      { params: Promise.resolve({ inviteId: invite.id }) },
    );
    expect(revoke.status).toBe(200);

    const token = url.split('/join/')[1]!;
    const claim = await claimMemberInvite(testDb.db, {
      token,
      name: 'X',
      email: 'x@example.test',
      password: 'correct-horse',
      hashPassword: fakeHash,
    });
    expect(claim).toEqual({ ok: false, reason: 'invalid_token' });

    const replay = await revokeInviteDelete(
      jsonRequest(`http://localhost/api/settings/members/invites/${invite.id}`, 'DELETE'),
      { params: Promise.resolve({ inviteId: invite.id }) },
    );
    expect(replay.status).toBe(404);
  });

  it('mints a reset link a Member can spend exactly once', async () => {
    const { url } = await mintInvite();
    const memberId = await claimAsMember(url, 'lisa@example.test');

    const minted = await resetPasswordPost(
      jsonRequest(`http://localhost/api/settings/members/${memberId}/reset-password`, 'POST'),
      { params: Promise.resolve({ userId: memberId }) },
    );
    expect(minted.status).toBe(200);
    const resetUrl = (await minted.json()).data.url as string;
    expect(resetUrl).toMatch(/^https:\/\/192\.168\.1\.10\/reset\//);

    const token = resetUrl.split('/reset/')[1]!;
    const spend = await joinResetPost(
      jsonRequest('http://localhost/api/join/reset', 'POST', {
        token,
        password: 'Brand-New-Password-1',
      }),
    );
    expect(spend.status).toBe(200);

    const replay = await joinResetPost(
      jsonRequest(
        'http://localhost/api/join/reset',
        'POST',
        { token, password: 'Again-Different-2' },
        '203.0.113.10',
      ),
    );
    expect(replay.status).toBe(404);
  });

  it('refuses to mint a reset link for the Admin', async () => {
    const refusal = await resetPasswordPost(
      jsonRequest(`http://localhost/api/settings/members/${holder.adminId}/reset-password`, 'POST'),
      { params: Promise.resolve({ userId: holder.adminId! }) },
    );
    expect(refusal.status).toBe(404);
  });

  it('disable is immediate (profile + login rows) and enable restores', async () => {
    const { url } = await mintInvite();
    const memberId = await claimAsMember(url, 'lisa@example.test');
    await testDb.db.insert(sessionTable).values({
      id: 'live-session',
      token: 'live-token',
      userId: memberId,
      expiresAt: new Date(Date.now() + 3_600_000),
      updatedAt: new Date(),
    });

    const disable = await disabledPost(
      jsonRequest(`http://localhost/api/settings/members/${memberId}/disabled`, 'POST', {
        disabled: true,
      }),
      { params: Promise.resolve({ userId: memberId }) },
    );
    expect(disable.status).toBe(200);
    expect((await resolveUserProfile(testDb.db, memberId))?.disabledAt).not.toBeNull();
    expect(
      await testDb.db.select().from(sessionTable).where(eq(sessionTable.userId, memberId)),
    ).toHaveLength(0);

    const enable = await disabledPost(
      jsonRequest(`http://localhost/api/settings/members/${memberId}/disabled`, 'POST', {
        disabled: false,
      }),
      { params: Promise.resolve({ userId: memberId }) },
    );
    expect(enable.status).toBe(200);
    expect((await resolveUserProfile(testDb.db, memberId))?.disabledAt).toBeNull();
  });

  it('the page payload is aggregates only — its exact shape is pinned', async () => {
    const { url } = await mintInvite('Lisa');
    await claimAsMember(url, 'lisa@example.test');

    const data = await loadMembersAdminData();
    expect(Object.keys(data).sort()).toEqual([
      'assistantDefault',
      'defaultBudget',
      'invites',
      'members',
      'overSubscription',
      'pool',
      'poolFigures',
      'tracksPerCall',
      'unitCosts',
    ]);
    expect(data.members).toHaveLength(1);
    // The whole member row: counts, bytes, dates, budget figures — no titles,
    // prompts, covers, or any other content field. A new key fails this test
    // until it is deliberately vetted as aggregate-only.
    expect(Object.keys(data.members[0]!).sort()).toEqual([
      'assistant',
      'budget',
      'disabled',
      'joinedAt',
      'lastActiveAt',
      'name',
      'storageBytes',
      'trackCount',
      'usage',
      'userId',
    ]);
    expect(data.members[0]!.usage).toMatchObject({
      kind: 'rolling',
      figures: { tracksDay: { used: 0, limit: 20, remaining: 20 } },
    });
  });

  it("refuses an invite budget carrying the other kind's fields", async () => {
    const response = await createInvitePost(
      jsonRequest('http://localhost/api/settings/members/invites', 'POST', {
        label: 'Lisa',
        budget: { kind: 'oneTime', dailyGenerationTasks: 5 },
      }),
    );
    expect(response.status).toBe(400);
  });

  // A One-time Member counts from the Grant — the claim time for an Invite — so
  // the card shows what they spent as a Member, and a lowered total shows 0 left
  // rather than a negative number, with the Grant untouched by the edit.
  it('a claimed One-time Invite counts from claim time; editing the total keeps the Grant', async () => {
    const { url } = await mintInvite('Lisa', {
      kind: 'oneTime',
      totalGenerationTasks: 5,
      totalGeneratedCovers: 3,
    });
    const claimedAt = new Date('2026-09-12T10:00:00.000Z');
    const memberId = await claimAsMember(url, 'lisa@example.test', claimedAt);
    expect(await getMemberLimits(testDb.db, memberId)).toMatchObject({
      kind: 'oneTime',
      totalGenerationTasks: 5,
      totalGeneratedCovers: 3,
      grantedAt: claimedAt.toISOString(),
    });

    await spendTask(memberId, new Date('2026-09-12T09:00:00.000Z'));
    await spendTask(memberId, new Date('2026-09-12T11:00:00.000Z'));
    await spendTask(memberId, new Date('2026-09-12T12:00:00.000Z'));

    const before = (await loadMembersAdminData()).members[0]!;
    expect(before.usage).toEqual({
      kind: 'oneTime',
      tracks: { used: 4, limit: 10, remaining: 6 },
      covers: { used: 0, limit: 3, remaining: 3 },
    });

    const lowered = await limitsPost(
      jsonRequest(`http://localhost/api/settings/members/${memberId}/limits`, 'POST', {
        totalGenerationTasks: 1,
      }),
      { params: Promise.resolve({ userId: memberId }) },
    );
    expect(lowered.status).toBe(200);

    const after = (await loadMembersAdminData()).members[0]!;
    expect(after.budget.grantedAt).toBe(claimedAt.toISOString());
    expect(after.usage).toEqual({
      kind: 'oneTime',
      tracks: { used: 4, limit: 2, remaining: 0 },
      covers: { used: 0, limit: 3, remaining: 3 },
    });
  });
});
