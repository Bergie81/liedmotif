// Which pages of the app the Assistant's model is told about, by the role of
// the user asking. The role comes from the user's profile row in a real
// database, as it does for every guard — the mocked Better Auth session says
// nothing about it — and the system prompt is read off what the model was sent.

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
import { APP_ROUTES } from '@/lib/assistant/route-map';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionUserId: null as string | null,
  llm: null as unknown,
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
vi.mock('@/lib/providers', () => ({ getLlmProvider: async () => holder.llm }));

const { POST } = await import('@/app/api/assistant/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

async function createProfiledUser(id: string, role: 'admin' | 'member'): Promise<string> {
  await testDb.db.insert(user).values({ id, name: id, email: `${id}@example.test` });
  await testDb.db.insert(userProfiles).values({ userId: id, role });
  return id;
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

  const response = await POST(
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

const ADMIN_ONLY = APP_ROUTES.filter((route) => route.adminOnly);
const FOR_EVERYONE = APP_ROUTES.filter((route) => !route.adminOnly && !route.memberOnly);

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('assistant-pages-by-role-test');
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

describe.skipIf(skip)('POST /api/assistant, by role', () => {
  it("never carries an admin-only page in a Member's prompt", async () => {
    const system = await systemPromptFor(await createProfiledUser('member-1', 'member'));

    expect(ADMIN_ONLY.map(({ path }) => path)).toContain('/settings/members');
    for (const route of ADMIN_ONLY) expect(system, route.path).not.toContain(route.path);
    for (const route of FOR_EVERYONE) expect(system, route.path).toContain(`${route.path} — `);
    expect(system).toContain('/settings/my-budget — ');
    expect(system).toContain('ask your Admin');
  });

  it('carries every page the Admin can open in the Admin’s prompt', async () => {
    const system = await systemPromptFor(await createProfiledUser('admin-1', 'admin'));

    for (const route of [...ADMIN_ONLY, ...FOR_EVERYONE]) {
      expect(system, route.path).toContain(`${route.path} — ${route.label}: `);
    }
    expect(system).not.toContain('ask your Admin');
  });

  it('sends every Member the same system prompt', async () => {
    const first = await systemPromptFor(await createProfiledUser('member-1', 'member'));
    const second = await systemPromptFor(await createProfiledUser('member-2', 'member'));

    expect(second).toBe(first);
  });
});
