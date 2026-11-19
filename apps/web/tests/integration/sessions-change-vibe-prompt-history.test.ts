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

// Prompt provenance on the write side:
// the Session's stored prompt ACCUMULATES — the creation text extended by each
// Change Vibe text with an empty line between them — instead of being replaced
// (a text change) or wiped (a controls change), so the origin survives for the
// requests that stamp it.

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
// Hermetic providers: the MOCK text LLM and music provider — no network, no spend.
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

const ORIGIN = 'calm music for late-night coding';

function post(route: (request: Request) => Promise<Response>, body: unknown) {
  return route(
    new Request('http://localhost/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function startSession(input: unknown): Promise<string> {
  const res = await post(startRoute, { input, clientId: 'change-vibe-prompt-history-test' });
  const parsed = startSessionResponseSchema.parse(await res.json());
  if (!parsed.ok) throw new Error('session start failed');
  return parsed.data.session.id;
}

async function changeVibe(sessionId: string, input: unknown): Promise<void> {
  const res = await post(changeVibeRoute, { sessionId, input });
  expect(res.status).toBe(200);
}

async function storedPrompt(sessionId: string): Promise<string | null> {
  const session = await getSessionById(testDb.db as Database, {
    ownerUserId: holder.ownerUserId!,
    sessionId,
  });
  if (!session) throw new Error('expected the session to exist');
  return session.userPrompt;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('sessions-change-vibe-prompt-history-test');
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

describe.skipIf(skip)('POST /api/sessions/change-vibe — the session prompt history', () => {
  it('extends the creation prompt with the change text, an empty line between them', async () => {
    const sessionId = await startSession({ mode: 'prompt', prompt: ORIGIN });

    await changeVibe(sessionId, { mode: 'prompt', prompt: 'mehr rockiger' });

    expect(await storedPrompt(sessionId)).toBe(`${ORIGIN}\n\nmehr rockiger`);
  });

  it('extends the history again on a second change', async () => {
    const sessionId = await startSession({ mode: 'prompt', prompt: ORIGIN });

    await changeVibe(sessionId, { mode: 'prompt', prompt: 'mehr rockiger' });
    await changeVibe(sessionId, { mode: 'prompt', prompt: 'with electronic vibes' });

    expect(await storedPrompt(sessionId)).toBe(
      `${ORIGIN}\n\nmehr rockiger\n\nwith electronic vibes`,
    );
  });

  it('leaves the history untouched when a controls change lands over a prompt session', async () => {
    const sessionId = await startSession({ mode: 'prompt', prompt: ORIGIN });

    await changeVibe(sessionId, { mode: 'controls', controls: { mood: 'stormy', energy: 'high' } });

    expect(await storedPrompt(sessionId)).toBe(ORIGIN);
  });

  it('adds nothing to the history for a picks-only change', async () => {
    const sessionId = await startSession({ mode: 'prompt', prompt: ORIGIN });
    await changeVibe(sessionId, { mode: 'prompt', prompt: 'mehr rockiger' });
    const history = (await storedPrompt(sessionId))!;

    await changeVibe(sessionId, { mode: 'picks', energy: 'high' });

    expect(await storedPrompt(sessionId)).toBe(history);
  });

  it('appends a message that repeats the history word for word, like any message', async () => {
    const sessionId = await startSession({ mode: 'prompt', prompt: ORIGIN });

    await changeVibe(sessionId, { mode: 'prompt', prompt: ORIGIN });

    expect(await storedPrompt(sessionId)).toBe(`${ORIGIN}\n\n${ORIGIN}`);
  });

  it('gives a controls session its first prompt only when a change carries text', async () => {
    const sessionId = await startSession({ mode: 'controls', controls: { mood: 'calm' } });
    expect(await storedPrompt(sessionId)).toBeNull();

    await changeVibe(sessionId, { mode: 'controls', controls: { mood: 'stormy' } });
    expect(await storedPrompt(sessionId)).toBeNull();

    await changeVibe(sessionId, { mode: 'prompt', prompt: 'make it rain outside' });
    expect(await storedPrompt(sessionId)).toBe('make it rain outside');
  });

  it('refuses a change whose text is only whitespace and stores no history', async () => {
    const sessionId = await startSession({ mode: 'controls', controls: { mood: 'calm' } });

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: '   ' },
    });

    expect(res.status).toBe(400);
    expect(await storedPrompt(sessionId)).toBeNull();
  });

  it('derives the new vibe from the change text alone, not from the accumulated history', async () => {
    const sessionId = await startSession({ mode: 'prompt', prompt: ORIGIN });

    await changeVibe(sessionId, { mode: 'prompt', prompt: 'hard techno', genres: ['techno'] });

    const session = await getSessionById(testDb.db as Database, {
      ownerUserId: holder.ownerUserId!,
      sessionId,
    });
    expect(session!.sessionStyleSnapshot?.genreTags?.[0]).toBe('techno');
  });
});
