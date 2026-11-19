import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from 'graphile-worker';
import { changeVibeResponseSchema, startSessionResponseSchema } from '@liedmotif/shared';
import { getSessionById, updateUsageLimits, type Database } from '@liedmotif/db';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// Per-owner Change Vibe budget. Each change makes a writing-AI call that no
// Track budget counts, so without this a script or a stuck client could repeat
// it and run up writing-AI cost on the Admin's key. It is its own budget,
// separate from Session creation's, and only a request that reaches the
// derivation takes from it.

const holder = vi.hoisted(() => ({
  db: null as unknown,
  ownerUserId: null as string | null,
  /** Whether a text LLM is configured for this test. */
  llmConfigured: true,
  /** Every reach for the text LLM — the derivation cannot happen without one. */
  llmProviderRequests: 0,
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
// Hermetic providers: mock LLM and music — a real `.env` must never let this
// suite spend money or touch the network.
vi.mock('@/lib/providers/providers', async () => {
  const { mockLlmProvider, mockMusicProvider } = await import('@liedmotif/providers');
  const music = mockMusicProvider();
  const llm = mockLlmProvider();
  return {
    getLlmProvider: async () => {
      holder.llmProviderRequests += 1;
      return holder.llmConfigured ? llm : null;
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

async function startSession(): Promise<string> {
  const started = await post(startRoute, {
    input: { mode: 'prompt', prompt: 'calm music for late-night coding' },
    clientId: 'change-vibe-rate-limit-test',
  });
  const parsed = startSessionResponseSchema.parse(await started.json());
  if (!parsed.ok) throw new Error('session start failed');
  return parsed.data.session.id;
}

function changeVibe(sessionId: string): Promise<Response> {
  return post(changeVibeRoute, { sessionId, input: { mode: 'prompt', prompt: 'hard techno' } });
}

async function burst(sessionId: string, n: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i += 1) statuses.push((await changeVibe(sessionId)).status);
  return statuses;
}

async function styleRevision(sessionId: string): Promise<number> {
  const session = await getSessionById(testDb.db as Database, {
    ownerUserId: holder.ownerUserId!,
    sessionId,
  });
  return session!.styleRevision;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('change-vibe-rate-limit-test');
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
  holder.llmConfigured = true;
  holder.llmProviderRequests = 0;
});

describe.skipIf(skip)('POST /api/sessions/change-vibe — per-owner rate limit', () => {
  it('refuses a burst past the limit with a retryable 429, and only for that owner', async () => {
    const sessionId = await startSession();

    const statuses = await burst(sessionId, 10);
    expect(statuses).toEqual(Array(10).fill(200));

    const revisionBefore = await styleRevision(sessionId);
    holder.llmProviderRequests = 0;
    const refused = await changeVibe(sessionId);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toMatch(/^\d+$/);
    const body = changeVibeResponseSchema.parse(await refused.json());
    expect(body.ok).toBe(false);
    if (!body.ok) {
      expect(body.error.code).toBe('rate_limited');
      expect(body.error.message).toBe('Too many requests. Please slow down.');
    }
    // The refusal is total: no writing-AI call, no new revision.
    expect(holder.llmProviderRequests).toBe(0);
    expect(await styleRevision(sessionId)).toBe(revisionBefore);

    // Another owner's window is untouched — one busy client never gates the rest.
    holder.ownerUserId = await createUser(testDb.db);
    expect((await changeVibe(await startSession())).status).toBe(200);
  });

  it('is a separate budget from starting a Session', async () => {
    const sessionId = await startSession();
    await burst(sessionId, 10);
    expect((await changeVibe(sessionId)).status).toBe(429);

    // Throws unless the start succeeds.
    await startSession();
  });

  it('counts every change that reaches the derivation, with or without a writing AI', async () => {
    holder.llmConfigured = false;
    const sessionId = await startSession();

    const statuses = await burst(sessionId, 11);
    expect(statuses).toEqual([...Array(10).fill(200), 429]);
  });

  it('takes nothing from the limit for a change refused by the music budget', async () => {
    await updateUsageLimits(testDb.db, {
      dailyGenerationTasks: 2,
      monthlyGenerationTasks: 400,
      resetTimezone: 'UTC',
      minHeadroomTracksToStartSession: 2,
    });
    const sessionId = await startSession();
    for (let i = 0; i < 2; i += 1) {
      const generationRequestId = await createGenerationRequest(testDb.db, {
        ownerUserId: holder.ownerUserId!,
      });
      await createProviderJob(testDb.db, { generationRequestId, submitState: 'submitted' });
    }

    for (let i = 0; i < 12; i += 1) {
      const response = await changeVibe(sessionId);
      const body = changeVibeResponseSchema.parse(await response.json());
      expect(body.ok).toBe(false);
      if (!body.ok) expect(body.error.code).toBe('session_headroom_blocked');
    }

    await updateUsageLimits(testDb.db, { dailyGenerationTasks: 400 });
    const statuses = await burst(sessionId, 11);
    expect(statuses).toEqual([...Array(10).fill(200), 429]);
  });
});
