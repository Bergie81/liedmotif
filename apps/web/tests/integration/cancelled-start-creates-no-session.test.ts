import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from 'graphile-worker';
import { startSessionResponseSchema } from '@liedmotif/shared';
import { mockLlmProvider, type LlmProvider } from '@liedmotif/providers';
import {
  connectTestDb,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// A Start the listener cancels while the vibe is still being set (the text LLM
// expansion inside the request) must buy nothing: no Session row, no buffer
// job, and the Session already Active — the one they kept listening to, or
// just resumed — is not superseded.

const holder = vi.hoisted(() => ({
  db: null as unknown,
  ownerUserId: null as string | null,
  llm: null as LlmProvider | null,
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
vi.mock('@/lib/providers/providers', async () => {
  const { mockMusicProvider } = await import('@liedmotif/providers');
  const music = mockMusicProvider();
  return {
    getLlmProvider: async () => holder.llm,
    getMusicProvider: () => music,
  };
});

const { POST } = await import('@/app/api/sessions/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function startRequest(input: unknown, signal?: AbortSignal) {
  return new Request('http://localhost/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, clientId: 'cancelled-start-client' }),
    ...(signal ? { signal } : {}),
  });
}

async function bufferJobCount(): Promise<number> {
  const { rows } = await testDb.pool.query(
    `select 1 from graphile_worker._private_jobs j
       join graphile_worker._private_tasks t on t.id = j.task_id
      where t.identifier = 'ensure-session-buffer'`,
  );
  return rows.length;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('cancelled-start-test');
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
  holder.llm = null;
});

describe.skipIf(skip)('POST /api/sessions — cancelled Start', () => {
  it('creates no session and keeps the Active one when cancelled during the vibe expansion', async () => {
    const kept = startSessionResponseSchema.parse(
      await (
        await POST(startRequest({ mode: 'controls', controls: { mood: 'calm', energy: 'low' } }))
      ).json(),
    );
    if (!kept.ok) throw new Error('expected the kept session to start');
    await testDb.pool.query('delete from graphile_worker._private_jobs');

    const cancel = new AbortController();
    const llm = mockLlmProvider();
    holder.llm = {
      ...llm,
      expandSessionIntentWithMetadata: async (...args) => {
        const expansion = await llm.expandSessionIntentWithMetadata(...args);
        cancel.abort();
        return expansion;
      },
    };

    const res = await POST(startRequest({ mode: 'prompt', prompt: 'rainy jazz' }, cancel.signal));
    expect(startSessionResponseSchema.parse(await res.json())).toMatchObject({ ok: false });

    const { rows } = await testDb.pool.query<{ id: string; status: string }>(
      'select id, status from activity_sessions',
    );
    expect(rows).toEqual([{ id: kept.data.session.id, status: 'active' }]);
    expect(await bufferJobCount()).toBe(0);
  });
});
