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

// Change Vibe is a paid-LLM surface: a free-text change runs the expansion and a
// naming call. Text-LLM spend has no budget window of its own, so the only thing
// standing between an exhausted owner and unmetered LLM calls is the money gate
// running BEFORE the derivation. That gate asks whether one more music-model call
// fits — not the new-Session headroom, which exists so a fresh Session can Repeat.

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

/** Daily cap of `dailyGenerationTasks` calls; the monthly window never binds. */
async function seedLimits(
  dailyGenerationTasks: number,
  extra: { minHeadroomTracksToStartSession?: number } = { minHeadroomTracksToStartSession: 2 },
): Promise<void> {
  await updateUsageLimits(testDb.db, {
    dailyGenerationTasks,
    monthlyGenerationTasks: 400,
    resetTimezone: 'UTC',
    ...extra,
  });
}

async function startSession(): Promise<string> {
  const started = await post(startRoute, {
    input: { mode: 'prompt', prompt: 'calm music for late-night coding' },
    clientId: 'change-vibe-headroom-test',
  });
  const parsedStart = startSessionResponseSchema.parse(await started.json());
  if (!parsedStart.ok) throw new Error('session start failed');
  return parsedStart.data.session.id;
}

/** Record `n` spent provider calls for the owner inside the current window. */
async function seedSpentTasks(ownerUserId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const generationRequestId = await createGenerationRequest(testDb.db, { ownerUserId });
    await createProviderJob(testDb.db, { generationRequestId, submitState: 'submitted' });
  }
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('sessions-change-vibe-headroom-test');
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

describe.skipIf(skip)('POST /api/sessions/change-vibe — the money gate', () => {
  it('accepts a change below the new-Session headroom while one music call still fits', async () => {
    // The default threshold (5 Tracks) with one call — 2 Tracks — left.
    await seedLimits(4, {});
    const sessionId = await startSession();
    await seedSpentTasks(holder.ownerUserId!, 3);

    const response = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: 'hard techno' },
    });

    expect(response.status).toBe(200);
  });

  it('refuses an exhausted owner before the paid derivation', async () => {
    await seedLimits(2);
    const sessionId = await startSession();
    const before = await getSessionById(testDb.db as Database, {
      ownerUserId: holder.ownerUserId!,
      sessionId,
    });

    await seedSpentTasks(holder.ownerUserId!, 2);
    holder.llmProviderRequests = 0;

    const response = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: 'hard techno' },
    });

    expect(response.status).toBe(429);
    const parsed = changeVibeResponseSchema.parse(await response.json());
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('session_headroom_blocked');
    expect(holder.llmProviderRequests).toBe(0);
    // The refusal is total: no new revision was minted for a fill that cannot run.
    const after = await getSessionById(testDb.db as Database, {
      ownerUserId: holder.ownerUserId!,
      sessionId,
    });
    expect(after!.styleRevision).toBe(before!.styleRevision);
  });
});
