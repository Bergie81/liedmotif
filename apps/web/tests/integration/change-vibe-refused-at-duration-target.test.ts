import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from 'graphile-worker';
import { changeVibeResponseSchema, startSessionResponseSchema } from '@liedmotif/shared';
import { getSessionById, setSessionDuration, type Database } from '@liedmotif/db';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// A Session at its duration target buys no more music, so a new
// vibe revision there could never fill: a paid derivation would buy nothing, and
// an armed switch-now would promise a cutover that never comes. The route
// refuses such a change before the text LLM is reached, unless the same edit
// lifts the target above the music already generated.

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

async function loadSession(sessionId: string) {
  const session = await getSessionById(testDb.db as Database, {
    ownerUserId: holder.ownerUserId!,
    sessionId,
  });
  if (!session) throw new Error('expected the session to exist');
  return session;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('change-vibe-refused-at-duration-target-test');
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

describe.skipIf(skip)('POST /api/sessions/change-vibe — at the duration target', () => {
  it('refuses a change before the derivation unless the same edit lifts the target past the generated music', async () => {
    const ownerUserId = holder.ownerUserId!;
    const started = startSessionResponseSchema.parse(
      await (
        await post(startRoute, {
          input: { mode: 'prompt', prompt: 'calm music for late-night coding' },
          clientId: 'change-vibe-duration-target-test',
        })
      ).json(),
    );
    if (!started.ok) throw new Error('session start failed');
    const sessionId = started.data.session.id;
    // 150 s of usable music against a 2-minute target: reached.
    const generationRequestId = await createGenerationRequest(testDb.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    await createTrack(testDb.db, {
      ownerUserId,
      generationRequestId,
      providerJobId: await createProviderJob(testDb.db, { generationRequestId }),
      status: 'ready',
      durationSeconds: 150,
      audioStorageKey: 'audio/duration-target.mp3',
    });
    await setSessionDuration(testDb.db as Database, {
      ownerUserId,
      sessionId,
      targetDurationMinutes: 2,
    });
    const before = await loadSession(sessionId);
    holder.llmProviderRequests = 0;

    // Unchanged target, and a raise that still sits at or below the 150 s.
    for (const targetDurationMinutes of [undefined, 1, 2]) {
      const response = await post(changeVibeRoute, {
        sessionId,
        input: { mode: 'prompt', prompt: 'hard techno' },
        switchImmediately: true,
        ...(targetDurationMinutes !== undefined ? { targetDurationMinutes } : {}),
      });
      expect(response.status).toBe(409);
      const parsed = changeVibeResponseSchema.parse(await response.json());
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.code).toBe('session_duration_reached');
    }
    expect(holder.llmProviderRequests).toBe(0);
    const refused = await loadSession(sessionId);
    expect(refused.styleRevision).toBe(before.styleRevision);
    expect(refused.vibeSwitchRevision).toBeNull();
    expect(refused.targetDurationMinutes).toBe(2);

    // A raise past the generated music lets the new revision fill.
    const raised = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: 'hard techno' },
      targetDurationMinutes: 3,
    });
    expect(raised.status).toBe(200);
    expect((await loadSession(sessionId)).styleRevision).toBe(before.styleRevision + 1);
  });
});
