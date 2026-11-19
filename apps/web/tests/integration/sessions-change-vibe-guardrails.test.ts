import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from 'graphile-worker';
import { startSessionResponseSchema } from '@liedmotif/shared';
import { getSessionById, type Database } from '@liedmotif/db';
import {
  connectTestDb,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// Change Vibe and the Session Guardrails:
// the running Session's frozen guardrails anchor the re-derivation, so a change
// that never mentions them keeps them, an explicit pick overwrites one, and an
// edited Avoid replaces the user's half of the compiled negative terms while
// the system steer (`vocals`) stays.

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
// Hermetic providers: the MOCK text LLM and the mock music provider — no
// network, no spend.
vi.mock('@/lib/providers/providers', async () => {
  const { mockLlmProvider, mockMusicProvider } = await import('@liedmotif/providers');
  const music = mockMusicProvider();
  const llm = mockLlmProvider();
  return {
    getLlmProvider: async () => llm,
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

/** An instrumental Session started with non-default guardrails on every axis. */
async function startGuardedSession(): Promise<string> {
  const res = await post(startRoute, {
    input: {
      mode: 'controls',
      controls: {
        mood: 'calm',
        energy: 'low',
        vocal: 'instrumental',
        styleStrength: 0.9,
        novelty: 0.05,
        avoid: 'saxophone',
      },
    },
    clientId: 'change-vibe-guardrails-test',
  });
  const parsed = startSessionResponseSchema.parse(await res.json());
  if (!parsed.ok) throw new Error('session start failed');
  return parsed.data.session.id;
}

async function loadSession(sessionId: string) {
  const session = await getSessionById(testDb.db as Database, {
    ownerUserId: holder.ownerUserId!,
    sessionId,
  });
  if (!session) throw new Error('expected the session to exist');
  return session;
}

async function guardrails(sessionId: string) {
  const snapshot = (await loadSession(sessionId)).sessionStyleSnapshot;
  return {
    styleStrength: snapshot?.styleStrength,
    novelty: snapshot?.novelty,
    userAvoid: snapshot?.userAvoid,
    negativeTerms: snapshot?.negativeTerms,
  };
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('sessions-change-vibe-guardrails-test');
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

describe.skipIf(skip)('POST /api/sessions/change-vibe — Session Guardrails', () => {
  it('freezes the guardrails a Session starts with', async () => {
    expect(await guardrails(await startGuardedSession())).toMatchObject({
      styleStrength: 0.9,
      novelty: 0.05,
      userAvoid: 'saxophone',
      negativeTerms: ['vocals', 'saxophone'],
    });
  });

  it('carries them through a free-text change that never mentions them', async () => {
    const sessionId = await startGuardedSession();

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: 'warmer and slower' },
    });
    expect(res.status).toBe(200);
    expect(await guardrails(sessionId)).toMatchObject({
      styleStrength: 0.9,
      novelty: 0.05,
      userAvoid: 'saxophone',
    });
  });

  it('lets a guardrail pick overwrite one level and leaves the other carried', async () => {
    const sessionId = await startGuardedSession();

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: 'warmer and slower', novelty: 0.6 },
    });
    expect(res.status).toBe(200);
    expect(await guardrails(sessionId)).toMatchObject({ novelty: 0.6, styleStrength: 0.9 });
  });

  it('a guardrails-ONLY change is a real revision that leaves the rest of the vibe alone', async () => {
    const sessionId = await startGuardedSession();
    const before = await loadSession(sessionId);

    // What the sheet sends for a picks-only controls change: the whole WYSIWYG
    // state, differing from the running Session in the levels alone.
    const res = await post(changeVibeRoute, {
      sessionId,
      input: {
        mode: 'controls',
        controls: {
          mood: 'calm',
          energy: 'low',
          vocal: 'instrumental',
          styleStrength: 0.2,
          novelty: 0.8,
          avoid: 'saxophone',
        },
      },
    });
    expect(res.status).toBe(200);

    const after = await loadSession(sessionId);
    expect(after.sessionStyleSnapshot?.styleStrength).toBe(0.2);
    expect(after.sessionStyleSnapshot?.novelty).toBe(0.8);
    // A new revision is what buys the initial fill; the frozen blend anchors and
    // the Session's naming must survive a change this small untouched.
    expect(after.styleRevision).toBe(before.styleRevision + 1);
    expect(after.sessionStyleSnapshot?.bpm).toBe(before.sessionStyleSnapshot?.bpm);
    expect(after.sessionStyleSnapshot?.key).toBe(before.sessionStyleSnapshot?.key);
    expect(after.sessionStyleSnapshot?.trackTitles).toEqual(
      before.sessionStyleSnapshot?.trackTitles,
    );
  });

  it('replaces the user’s negative terms when Avoid is cleared, keeping the system steer', async () => {
    const sessionId = await startGuardedSession();

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: 'warmer and slower', avoid: '' },
    });
    expect(res.status).toBe(200);
    const after = await guardrails(sessionId);
    expect(after.userAvoid).toBeUndefined();
    expect(after.negativeTerms).toEqual(['vocals']);
  });
});
