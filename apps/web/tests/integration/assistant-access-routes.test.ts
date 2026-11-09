// The Admin's write path for Assistant access: the instance default every
// Member follows, and one Member's own values over it.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSISTANT_DAILY_MESSAGES_MAX,
  ASSISTANT_DAILY_MESSAGES_MIN,
  DEFAULT_ASSISTANT_ACCESS,
} from '@liedmotif/shared';
import {
  getAssistantAccess,
  getMemberAssistantAccess,
  resolveAssistantStanding,
  user,
  userProfiles,
} from '@liedmotif/db';
import {
  connectTestDb,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

const holder = vi.hoisted(() => ({ db: null as unknown, admin: true }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
// A Member holds an app session and no admin session.
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.admin ? { user: { id: 'admin-1' } } : null),
  getAppSession: async () => ({ user: { id: holder.admin ? 'admin-1' : 'member-1' } }),
}));
vi.mock('@/lib/providers', () => ({ getTypicalTracksPerMusicRequest: () => 2 }));

const instanceDefault = await import('@/app/api/settings/members/assistant/route');
const oneMember = await import('@/app/api/settings/members/[userId]/assistant/route');
const { loadMembersAdminData } = await import('@/lib/members-admin-data');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function postDefault(body: unknown) {
  return instanceDefault.POST(
    new Request('http://localhost/api/settings/members/assistant', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
}

function postMember(userId: string, body: unknown) {
  return oneMember.POST(
    new Request(`http://localhost/api/settings/members/${userId}/assistant`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ userId }) },
  );
}

async function createUser(id: string, role: 'admin' | 'member'): Promise<string> {
  await testDb.db.insert(user).values({ id, name: id, email: `${id}@example.test` });
  await testDb.db.insert(userProfiles).values({ userId: id, role });
  return id;
}

/** What the Assistant holds a Member to right now. */
async function standingOf(userId: string) {
  const standing = await resolveAssistantStanding(testDb.db, {
    userId,
    role: 'member',
    now: new Date(),
  });
  return { enabled: standing.enabled, dailyMessages: standing.allowance?.dailyMessages };
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('assistant-access-routes-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, ['user', 'user_settings', 'app_settings']);
  holder.admin = true;
});

describe.skipIf(skip)('Assistant access routes', () => {
  it('refuses a Member on every write route and stores nothing', async () => {
    await createUser('member-1', 'member');
    await createUser('member-2', 'member');
    holder.admin = false;

    expect((await postDefault({ dailyMessages: 500 })).status).toBe(401);
    expect((await postMember('member-1', { dailyMessages: 500 })).status).toBe(401);
    expect((await postMember('member-2', { enabled: false })).status).toBe(401);

    expect(await getAssistantAccess(testDb.db)).toEqual(DEFAULT_ASSISTANT_ACCESS);
    expect(await getMemberAssistantAccess(testDb.db, 'member-1')).toEqual({});
    expect(await getMemberAssistantAccess(testDb.db, 'member-2')).toEqual({});
  });

  it('changes the instance default one field at a time', async () => {
    const off = await postDefault({ enabled: false });
    expect(off.status).toBe(200);
    expect((await off.json()).data.access).toEqual({ enabled: false, dailyMessages: 30 });

    const fewer = await postDefault({ dailyMessages: 12 });
    expect((await fewer.json()).data.access).toEqual({ enabled: false, dailyMessages: 12 });
  });

  it('moves every Member without values of their own when the default changes', async () => {
    await createUser('member-1', 'member');
    await createUser('member-2', 'member');
    await postMember('member-2', { dailyMessages: 5 });

    await postDefault({ enabled: false, dailyMessages: 12 });

    expect(await standingOf('member-1')).toEqual({ enabled: false, dailyMessages: 12 });
    expect(await standingOf('member-2')).toEqual({ enabled: false, dailyMessages: 5 });
  });

  it.each([
    { dailyMessages: ASSISTANT_DAILY_MESSAGES_MIN - 1 },
    { dailyMessages: ASSISTANT_DAILY_MESSAGES_MAX + 1 },
    { dailyMessages: 2.5 },
    { dailyMessages: '30' },
    { enabled: 'yes' },
    { monthlyMessages: 5 },
  ])('refuses %j for the default and for a Member', async (body) => {
    const memberId = await createUser('member-1', 'member');

    expect((await postDefault(body)).status).toBe(400);
    expect((await postMember(memberId, body)).status).toBe(400);

    expect(await getAssistantAccess(testDb.db)).toEqual(DEFAULT_ASSISTANT_ACCESS);
    expect(await getMemberAssistantAccess(testDb.db, memberId)).toEqual({});
  });

  it('accepts both ends of the allowance range', async () => {
    const memberId = await createUser('member-1', 'member');
    expect((await postDefault({ dailyMessages: ASSISTANT_DAILY_MESSAGES_MAX })).status).toBe(200);
    expect(
      (await postMember(memberId, { dailyMessages: ASSISTANT_DAILY_MESSAGES_MIN })).status,
    ).toBe(200);
    expect(await standingOf(memberId)).toEqual({ enabled: true, dailyMessages: 1 });
  });

  it('refuses to clear the instance default', async () => {
    expect((await postDefault({ dailyMessages: null })).status).toBe(400);
    expect((await postDefault({ enabled: null })).status).toBe(400);
  });

  it("switches the Assistant off for one Member and sets that Member's allowance", async () => {
    const memberId = await createUser('member-1', 'member');
    await createUser('member-2', 'member');

    const off = await postMember(memberId, { enabled: false });
    expect(off.status).toBe(200);
    expect((await off.json()).data.access).toEqual({ enabled: false });

    const fewer = await postMember(memberId, { dailyMessages: 5 });
    expect((await fewer.json()).data.access).toEqual({ enabled: false, dailyMessages: 5 });

    expect(await standingOf(memberId)).toEqual({ enabled: false, dailyMessages: 5 });
    expect(await standingOf('member-2')).toEqual({ enabled: true, dailyMessages: 30 });
  });

  it("clears a Member's own value so the default applies again", async () => {
    const memberId = await createUser('member-1', 'member');
    await postMember(memberId, { enabled: false, dailyMessages: 5 });

    const oneCleared = await postMember(memberId, { enabled: null });
    expect((await oneCleared.json()).data.access).toEqual({ dailyMessages: 5 });
    expect(await standingOf(memberId)).toEqual({ enabled: true, dailyMessages: 5 });

    const allCleared = await postMember(memberId, { enabled: null, dailyMessages: null });
    expect((await allCleared.json()).data.access).toEqual({});
    expect(await standingOf(memberId)).toEqual({ enabled: true, dailyMessages: 30 });
  });

  it("hands the Members page the default and each Member's own values", async () => {
    await createUser('admin-1', 'admin');
    await createUser('member-1', 'member');
    await createUser('member-2', 'member');
    await postDefault({ dailyMessages: 12 });
    await postMember('member-2', { enabled: false });

    const data = await loadMembersAdminData();

    expect(data.assistantDefault).toEqual({ enabled: true, dailyMessages: 12 });
    expect(
      Object.fromEntries(data.members.map((member) => [member.userId, member.assistant])),
    ).toEqual({ 'member-1': {}, 'member-2': { enabled: false } });
  });

  it('refuses a write for the Admin or an unknown user', async () => {
    await createUser('admin-1', 'admin');
    expect((await postMember('admin-1', { enabled: false })).status).toBe(404);
    expect((await postMember('nobody', { enabled: false })).status).toBe(404);
  });
});
