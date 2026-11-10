// Who has the Assistant at all, which decides whether its launcher, its row in
// Settings and its settings page are offered: a text LLM has to be set up, and
// the user's access has to be on. Read against a real database.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateMemberAssistantAccess, user, userProfiles } from '@liedmotif/db';
import {
  connectTestDb,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { cachedAssistantAvailability } from '@/lib/assistant/availability';

const holder = vi.hoisted(() => ({ llm: null as unknown, llmFails: false }));
vi.mock('@/lib/providers', () => ({
  getLlmProvider: async () => {
    if (holder.llmFails) throw new Error('credential could not be read');
    return holder.llm;
  },
}));

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

async function createProfiledUser(id: string, role: 'admin' | 'member'): Promise<string> {
  await testDb.db.insert(user).values({ id, name: id, email: `${id}@example.test` });
  await testDb.db.insert(userProfiles).values({ userId: id, role });
  return id;
}

const availableTo = async (userId: string, role: 'admin' | 'member') =>
  (await cachedAssistantAvailability(testDb.db, userId, role)).available;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('assistant-availability-test');
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, ['user_settings', 'app_settings', 'user']);
  holder.llm = { providerKey: 'test' };
  holder.llmFails = false;
});

describe.skipIf(skip)('who has the Assistant', () => {
  it('the Admin and a Member have it while a text LLM is set up', async () => {
    expect(await availableTo(await createProfiledUser('admin-1', 'admin'), 'admin')).toBe(true);
    expect(await availableTo(await createProfiledUser('member-1', 'member'), 'member')).toBe(true);
  });

  it('nobody has it without a text LLM', async () => {
    holder.llm = null;
    expect(await availableTo(await createProfiledUser('admin-1', 'admin'), 'admin')).toBe(false);
  });

  it('a Member whose access the Admin switched off does not have it', async () => {
    const member = await createProfiledUser('member-1', 'member');
    await updateMemberAssistantAccess(testDb.db, {
      ownerUserId: member,
      patch: { enabled: false },
    });
    expect(await availableTo(member, 'member')).toBe(false);
  });

  it('a text LLM that cannot be read counts as none, and fails nothing', async () => {
    holder.llmFails = true;
    expect(await availableTo(await createProfiledUser('admin-1', 'admin'), 'admin')).toBe(false);
  });
});
