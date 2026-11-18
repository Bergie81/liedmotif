import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from 'graphile-worker';
import { startSessionResponseSchema } from '@liedmotif/shared';
import { getSessionById, type Database } from '@liedmotif/db';
import type { ExpansionOptions } from '@liedmotif/providers';
import {
  connectTestDb,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// Change Vibe keeps the session's lyrical direction: a change message is an
// ADJUSTMENT, so the running lyric notes and the session's prompt history reach
// the expansion as context to edit — and whatever the model gives back, the
// notes are never silently erased except by going instrumental.

const holder = vi.hoisted(() => ({
  db: null as unknown,
  ownerUserId: null as string | null,
  /** The personalization context every expansion call was handed, newest last. */
  expansions: [] as (ExpansionOptions | undefined)[],
  /** Notes the stub model returns instead of the mock's own, or null. */
  editedNotes: null as string | null,
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
// Hermetic providers: the mock music provider, and the mock text LLM behind a
// capturing stub — the capture proves WHAT reached the model, the override
// proves what the route does with an edited reply. No network, no spend.
vi.mock('@/lib/providers', async () => {
  const { mockLlmProvider, mockMusicProvider } = await import('@liedmotif/providers');
  const music = mockMusicProvider();
  const llm = mockLlmProvider();
  const capturing: typeof llm = {
    ...llm,
    async expandSessionIntentWithMetadata(intent, listener, picks, options) {
      holder.expansions.push(options);
      const result = await llm.expandSessionIntentWithMetadata(intent, listener, picks, options);
      if (holder.editedNotes === null) return result;
      return { ...result, snapshot: { ...result.snapshot, lyricContext: holder.editedNotes } };
    },
  };
  return { getLlmProvider: async () => capturing, getMusicProvider: () => music };
});

const { POST: startRoute } = await import('@/app/api/sessions/route');
const { POST: changeVibeRoute } = await import('@/app/api/sessions/change-vibe/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

// The mock LLM writes `people: <profile name>` notes for a vocal session with a
// listener profile, so the stored lyricContext is observable without a real model.
const ORIGIN = 'sing a gentle song about the sea';

function post(route: (request: Request) => Promise<Response>, body: unknown) {
  return route(
    new Request('http://localhost/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function startVocalSession(): Promise<string> {
  const res = await post(startRoute, {
    input: { mode: 'prompt', prompt: ORIGIN },
    clientId: 'change-vibe-lyrics-test',
  });
  const parsed = startSessionResponseSchema.parse(await res.json());
  if (!parsed.ok) throw new Error('session start failed');
  return parsed.data.session.id;
}

async function changeVibe(sessionId: string, input: unknown): Promise<void> {
  const res = await post(changeVibeRoute, { sessionId, input });
  expect(res.status).toBe(200);
}

async function storedNotes(sessionId: string): Promise<string | undefined> {
  const session = await getSessionById(testDb.db as Database, {
    ownerUserId: holder.ownerUserId!,
    sessionId,
  });
  if (!session) throw new Error('expected the session to exist');
  return session.sessionStyleSnapshot?.lyricContext;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('sessions-change-vibe-lyrics-test');
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
  holder.expansions = [];
  holder.editedNotes = null;
});

describe.skipIf(skip)('POST /api/sessions/change-vibe — the lyrical direction', () => {
  it('sends the running notes and the prompt history to the expansion', async () => {
    const sessionId = await startVocalSession();
    const before = await storedNotes(sessionId);
    expect(before).toBeTruthy();

    await changeVibe(sessionId, { mode: 'prompt', prompt: 'sing about berlin instead' });

    expect(holder.expansions.at(-1)).toMatchObject({
      adjustFrom: { lyricContext: before },
      promptHistory: ORIGIN,
    });
  });

  it('persists the notes the model edited', async () => {
    const sessionId = await startVocalSession();
    holder.editedNotes = 'people: Test Admin; setting: berlin harbour; imagery: grey water';

    await changeVibe(sessionId, { mode: 'prompt', prompt: 'sing about berlin instead' });

    expect(await storedNotes(sessionId)).toBe(holder.editedNotes);
  });

  it('keeps the current notes when the model returns none', async () => {
    const sessionId = await startVocalSession();
    const before = await storedNotes(sessionId);
    holder.editedNotes = '';

    await changeVibe(sessionId, { mode: 'prompt', prompt: 'a bit more melancholic' });

    expect(await storedNotes(sessionId)).toBe(before);
  });

  it('keeps the current notes through a picks-only controls change (no expansion at all)', async () => {
    const sessionId = await startVocalSession();
    const before = await storedNotes(sessionId);
    holder.expansions = [];

    await changeVibe(sessionId, { mode: 'controls', controls: { mood: 'stormy', vocal: 'vocal' } });

    expect(holder.expansions).toEqual([]);
    expect(await storedNotes(sessionId)).toBe(before);
  });

  it('keeps the current notes through a picks-only fine-tune of a free-text session', async () => {
    const sessionId = await startVocalSession();
    const before = await storedNotes(sessionId);

    // What the Change Vibe sheet sends when only a chip moved.
    await changeVibe(sessionId, { mode: 'picks', energy: 'high' });

    expect(holder.expansions.at(-1)).toMatchObject({
      adjustFrom: { lyricContext: before },
      promptHistory: ORIGIN,
    });
    expect(await storedNotes(sessionId)).toBe(before);
  });

  it('clears the notes when the change turns the session instrumental', async () => {
    const sessionId = await startVocalSession();

    await changeVibe(sessionId, {
      mode: 'prompt',
      prompt: 'make it instrumental',
      vocal: 'instrumental',
    });

    expect(await storedNotes(sessionId)).toBe('');
  });
});
