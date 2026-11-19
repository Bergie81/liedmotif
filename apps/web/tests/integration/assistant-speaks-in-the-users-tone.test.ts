// The voice the Assistant's model is told to speak in, by the tone the asking
// user saved. The tone is saved through the settings route and read off what
// the model was sent, against a real database.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { user, userProfiles } from '@liedmotif/db';
import {
  connectTestDb,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { createOpenRouterLlmProvider } from '@liedmotif/providers';
import { scriptedLanguageModel } from '@liedmotif/providers/testing';
import { DEFAULT_VOICE } from '@/lib/assistant/persona';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionUserId: null as string | null,
  llm: null as unknown,
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/auth', () => ({
  getAuth: () => ({
    api: {
      getSession: async () =>
        holder.sessionUserId
          ? { session: { id: 'live' }, user: { id: holder.sessionUserId } }
          : null,
    },
  }),
}));
vi.mock('@/lib/providers/providers', () => ({ getLlmProvider: async () => holder.llm }));

const { POST: ask } = await import('@/app/api/assistant/route');
const { POST: saveToneRoute } = await import('@/app/api/settings/assistant-tone/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

const CAPTAIN = 'Talk like a ship captain. Short orders, no small talk.';

async function createProfiledUser(id: string, role: 'admin' | 'member'): Promise<string> {
  await testDb.db.insert(user).values({ id, name: id, email: `${id}@example.test` });
  await testDb.db.insert(userProfiles).values({ userId: id, role });
  return id;
}

async function saveTone(userId: string, tone: string): Promise<void> {
  holder.sessionUserId = userId;
  const response = await saveToneRoute(
    new Request('http://localhost/api/settings/assistant-tone', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tone }),
    }),
  );
  expect(response.status).toBe(200);
}

/** The system prompt the model is sent when `userId` asks a question. */
async function systemPromptFor(userId: string): Promise<string> {
  const model = scriptedLanguageModel([{ text: ['Sure.'] }]);
  holder.llm = createOpenRouterLlmProvider({
    apiKey: 'sk-or-test-key',
    model: 'test-model',
    languageModel: model,
  });
  holder.sessionUserId = userId;

  const response = await ask(
    new Request('http://localhost/api/assistant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'How do I invite someone?' }] }),
    }),
  );
  expect(response.status).toBe(200);
  await response.text();

  const system = model.doStreamCalls[0]?.prompt[0];
  expect(system).toMatchObject({ role: 'system' });
  return String(system?.content);
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('assistant-users-tone-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, ['user_settings', 'user']);
  holder.sessionUserId = null;
});

describe.skipIf(skip)('POST /api/assistant, by the tone the user saved', () => {
  it('speaks in the default voice until the user saves a tone, and in that tone from their next message', async () => {
    const admin = await createProfiledUser('admin-1', 'admin');

    const before = await systemPromptFor(admin);
    await saveTone(admin, CAPTAIN);
    const after = await systemPromptFor(admin);

    expect(before).toContain(DEFAULT_VOICE);
    expect(before).not.toContain(CAPTAIN);
    expect(after).toContain(CAPTAIN);
    expect(after).not.toContain(DEFAULT_VOICE);
  });

  it("speaks to each user in their own voice, and leaves another user's alone", async () => {
    const first = await createProfiledUser('member-1', 'member');
    const second = await createProfiledUser('member-2', 'member');
    await saveTone(first, CAPTAIN);

    expect(await systemPromptFor(first)).toContain(CAPTAIN);
    const other = await systemPromptFor(second);
    expect(other).not.toContain(CAPTAIN);
    expect(other).toContain(DEFAULT_VOICE);
  });
});
