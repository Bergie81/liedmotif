import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from 'graphile-worker';
import { changeVibeResponseSchema, startSessionResponseSchema } from '@liedmotif/shared';
import { getSessionById, stopSession, type Database } from '@liedmotif/db';
import {
  connectTestDb,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// A Stopped Session never gets a new revision's fill, so a Change Vibe there
// buys no music: the route refuses it before the text LLM is reached, or the
// paid derivation would be spent on a change that is then refused anyway.

const holder = vi.hoisted(() => ({
  db: null as unknown,
  ownerUserId: null as string | null,
  /** Every reach for the text LLM — the derivation cannot happen without one. */
  llmProviderRequests: 0,
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
vi.mock('@/lib/providers/providers', async () => {
  const { mockLlmProvider, mockMusicProvider } = await import('@liedmotif/providers');
  const music = mockMusicProvider();
  const llm = mockLlmProvider();
  return {
    getLlmProvider: async () => {
      holder.llmProviderRequests += 1;
      return llm;
    },
    getMusicProvider: () => music,
  };
});

const { POST: startRoute } = await import('@/app/api/sessions/route');
const { POST: changeVibeRoute } = await import('@/app/api/sessions/change-vibe/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function post(route: (request: Request) => Promise<Response>, body: unknown) {
  return route(
    new Request('http://localhost/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('change-vibe-refused-on-stopped-session-test');
  holder.db = testDb.db;
  await runMigrations({ connectionString: TEST_DATABASE_URL });
}, 60_000);
afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});
beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, [...GENERATION_FIXTURE_TABLES, 'app_settings']);
  await testDb.pool.query('delete from graphile_worker._private_jobs');
  holder.ownerUserId = await createUser(testDb.db);
});

describe.skipIf(skip)('POST /api/sessions/change-vibe — on a Stopped Session', () => {
  it('refuses the change before the text LLM is reached', async () => {
    const ownerUserId = holder.ownerUserId!;
    const started = startSessionResponseSchema.parse(
      await (
        await post(startRoute, {
          input: { mode: 'prompt', prompt: 'calm music for late-night coding' },
          clientId: 'change-vibe-stopped-session-test',
        })
      ).json(),
    );
    if (!started.ok) throw new Error('session start failed');
    const sessionId = started.data.session.id;
    await stopSession(testDb.db as Database, { ownerUserId, sessionId });
    holder.llmProviderRequests = 0;

    const response = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: 'hard techno' },
    });

    expect(response.status).toBe(409);
    const parsed = changeVibeResponseSchema.parse(await response.json());
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('conflict');
    expect(holder.llmProviderRequests).toBe(0);
    const session = await getSessionById(testDb.db as Database, { ownerUserId, sessionId });
    expect(session?.status).toBe('stopped');
  });
});
