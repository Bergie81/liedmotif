import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from 'graphile-worker';
import {
  connectTestDb,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// Per-owner session-creation budget. Session creation's only
// gate is MUSIC headroom, which the text LLM never decrements, and each create
// supersedes the last — so without this a scripted loop burns expansion and
// naming calls indefinitely against a budget that never moves.

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
// Hermetic providers: no text LLM, mock music — a real `.env` must never let
// this suite spend money or touch the network.
vi.mock('@/lib/providers/providers', async () => {
  const { mockMusicProvider } = await import('@liedmotif/providers');
  const music = mockMusicProvider();
  return { getLlmProvider: async () => null, getMusicProvider: () => music };
});

const { POST } = await import('@/app/api/sessions/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function startSession(): Promise<Response> {
  return POST(
    new Request('http://localhost/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: { mode: 'controls', controls: { mood: 'calm', energy: 'low' } },
        clientId: 'create-rate-limit-test-client',
      }),
    }),
  );
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('session-create-rate-limit-test');
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
  // A fresh owner per test — the budget is keyed on the owner, so each test
  // starts with a full window without reaching into the limiter's state.
  holder.ownerUserId = await createUser(testDb.db);
});

describe.skipIf(skip)('POST /api/sessions — per-owner creation budget', () => {
  it('refuses a burst past the budget with a retryable 429, and only for that owner', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await startSession()).status);

    expect(statuses.filter((status) => status === 200)).toHaveLength(10);
    expect(statuses.slice(10)).toEqual([429, 429]);
    const refused = await startSession();
    expect(refused.headers.get('Retry-After')).toMatch(/^\d+$/);

    // Another owner's window is untouched — one busy client never gates the rest.
    holder.ownerUserId = await createUser(testDb.db);
    expect((await startSession()).status).toBe(200);
  });
});
