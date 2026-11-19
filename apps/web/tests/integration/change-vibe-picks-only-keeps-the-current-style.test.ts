import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from 'graphile-worker';
import { startSessionResponseSchema } from '@liedmotif/shared';
import { createPerson, getSessionById, type Database, type StyleSnapshot } from '@liedmotif/db';
import {
  connectTestDb,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// A Change Vibe that moves only fine-tune picks adjusts the CURRENT Style
// Snapshot by those picks: the prompt history stays provenance, never a request
// to apply again, and the Session's stored controls are left alone — so a More
// Like This Session never turns controls-born.

const holder = vi.hoisted(() => ({
  db: null as unknown,
  ownerUserId: null as string | null,
  llmConfigured: true,
  failExpansion: false,
  /** Every text-LLM call, by method, with its arguments. */
  calls: [] as { method: string; args: unknown[] }[],
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
// Hermetic providers: the mock music provider, and the mock text LLM behind a
// recorder that counts every call; it can be switched off or made to fail.
vi.mock('@/lib/providers', async () => {
  const { mockLlmProvider, mockMusicProvider, ProviderError } =
    await import('@liedmotif/providers');
  const music = mockMusicProvider();
  const real = mockLlmProvider();
  const llm = Object.fromEntries(
    Object.entries(real).map(([key, value]) => [
      key,
      typeof value === 'function'
        ? (...args: unknown[]) => {
            holder.calls.push({ method: key, args });
            if (holder.failExpansion && key === 'expandSessionIntentWithMetadata') {
              throw new ProviderError('The Text AI could not read the change.');
            }
            return (value as (...callArgs: unknown[]) => unknown).apply(real, args);
          }
        : value,
    ]),
  ) as typeof real;
  return {
    getLlmProvider: async () => (holder.llmConfigured ? llm : null),
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

async function startSession(input: unknown): Promise<string> {
  const res = await post(startRoute, { input, clientId: 'change-vibe-picks-only-test' });
  const parsed = startSessionResponseSchema.parse(await res.json());
  if (!parsed.ok) throw new Error('session start failed');
  return parsed.data.session.id;
}

async function changeVibe(sessionId: string, input: unknown): Promise<Response> {
  return post(changeVibeRoute, { sessionId, input });
}

async function changeVibeOk(sessionId: string, input: unknown): Promise<void> {
  expect((await changeVibe(sessionId, input)).status).toBe(200);
}

async function loadSession(sessionId: string) {
  const session = await getSessionById(testDb.db as Database, {
    ownerUserId: holder.ownerUserId!,
    sessionId,
  });
  if (!session) throw new Error('expected the session to exist');
  return session;
}

/** The text-LLM calls a change made, counted from a clean slate. */
async function callsDuring(change: () => Promise<void>) {
  holder.calls = [];
  await change();
  return holder.calls;
}

/** A More Like This Session: a seeded snapshot, no prompt, no stored controls. */
const SEEDED: StyleSnapshot = {
  stylePrompt: 'warm synthwave, night drive',
  negativeTerms: [],
  genreTags: ['synthwave'],
  vocalMode: 'vocal',
  energy: 'medium',
  language: 'German',
  voiceGender: 'female',
  bpm: 104,
  key: 'F minor',
  title: 'Neon Nights',
  trackTitles: ['Neon Dawn', 'Neon Drift'],
  lyricContext: 'scene: rooftop at dusk',
  seedParameters: { baseSeed: 7 },
};

async function seededSession(): Promise<string> {
  return createSession(testDb.db, {
    ownerUserId: holder.ownerUserId!,
    styleSnapshot: SEEDED,
    title: 'Neon Nights',
  });
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('change-vibe-picks-only-test');
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
  holder.llmConfigured = true;
  holder.failExpansion = false;
  holder.calls = [];
});

describe.skipIf(skip)('POST /api/sessions/change-vibe — picks only, with a writing AI', () => {
  it('anchors on the current style and never applies the earlier requests again', async () => {
    const sessionId = await startSession({ mode: 'prompt', prompt: 'calm piano for reading' });
    await changeVibeOk(sessionId, { mode: 'prompt', prompt: 'make it rockier' });
    const before = await loadSession(sessionId);
    const history = 'calm piano for reading\n\nmake it rockier';
    expect(before.userPrompt).toBe(history);

    const calls = await callsDuring(() =>
      changeVibeOk(sessionId, { mode: 'picks', energy: 'high' }),
    );

    // One anchored derivation with no change message, and no naming call.
    expect(calls.map((call) => call.method)).toEqual(['expandSessionIntentWithMetadata']);
    const [intent, , picks, options] = calls[0]!.args as [string, unknown, unknown, never];
    expect(intent).toBe('');
    expect(picks).toEqual({ energy: 'high' });
    expect(options).toMatchObject({
      adjustFrom: { stylePrompt: before.sessionStyleSnapshot!.stylePrompt },
      promptHistory: history,
    });

    const after = await loadSession(sessionId);
    expect(after.styleRevision).toBe(before.styleRevision + 1);
    expect(after.sessionStyleSnapshot?.stylePrompt).toBe(
      `${before.sessionStyleSnapshot!.stylePrompt}, high energy`,
    );
    expect(after.sessionStyleSnapshot?.energy).toBe('high');
    // Provenance and stored controls stay exactly as they were.
    expect(after.userPrompt).toBe(history);
    expect(after.structuredControls).toBeNull();
    expect(after.title).toBe(before.title);
  });

  it('keeps a More Like This Session anchored on its seed, change after change', async () => {
    const sessionId = await seededSession();

    const first = await callsDuring(() =>
      changeVibeOk(sessionId, { mode: 'picks', genres: ['techno'] }),
    );
    const afterFirst = await loadSession(sessionId);
    expect(first).toHaveLength(1);
    expect(afterFirst.sessionStyleSnapshot).toMatchObject({
      stylePrompt: 'techno, warm synthwave, night drive',
      genreTags: ['techno', 'synthwave'],
      vocalMode: 'vocal',
      language: 'German',
      voiceGender: 'female',
      bpm: 104,
      key: 'F minor',
      title: 'Neon Nights',
      trackTitles: ['Neon Dawn', 'Neon Drift'],
      lyricContext: 'scene: rooftop at dusk',
    });
    expect(afterFirst.structuredControls).toBeNull();
    expect(afterFirst.userPrompt).toBeNull();

    const second = await callsDuring(() =>
      changeVibeOk(sessionId, { mode: 'picks', energy: 'low' }),
    );
    const afterSecond = await loadSession(sessionId);
    expect(second).toHaveLength(1);
    expect(afterSecond.sessionStyleSnapshot).toMatchObject({
      stylePrompt: 'techno, warm synthwave, night drive, low energy',
      genreTags: ['techno', 'synthwave'],
      energy: 'low',
      language: 'German',
    });
    expect(afterSecond.sessionStyleSnapshot?.bpm).not.toBe(104);
    expect(afterSecond.structuredControls).toBeNull();
    expect(afterSecond.title).toBe('Neon Nights');
  });

  it('answers a failing call with the retryable provider error and writes nothing', async () => {
    const sessionId = await seededSession();
    const before = await loadSession(sessionId);
    holder.failExpansion = true;

    const res = await changeVibe(sessionId, { mode: 'picks', energy: 'high' });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: 'provider_error', retryable: true } });
    const after = await loadSession(sessionId);
    expect(after.styleRevision).toBe(before.styleRevision);
    expect(after.sessionStyleSnapshot?.energy).toBe('medium');
  });

  it('still makes the one call when only a Guardrail slider moved', async () => {
    const sessionId = await seededSession();

    const calls = await callsDuring(() => changeVibeOk(sessionId, { mode: 'picks', novelty: 0.8 }));

    expect(calls).toHaveLength(1);
    const snapshot = (await loadSession(sessionId)).sessionStyleSnapshot!;
    expect(snapshot.novelty).toBe(0.8);
    expect(snapshot.stylePrompt).toBe(SEEDED.stylePrompt);
  });

  it('keeps the cover concept and its Auto cover style, whatever the reply proposes', async () => {
    const sessionId = await seededSession();
    await testDb.pool.query(
      `update activity_sessions set cover_concept = $1, auto_cover_style = 'drawing' where id = $2`,
      ['A lighthouse at dawn', sessionId],
    );

    await changeVibeOk(sessionId, { mode: 'picks', energy: 'high' });

    const after = await loadSession(sessionId);
    expect(after.coverConcept).toBe('A lighthouse at dawn');
    expect(after.autoCoverStyle).toBe('drawing');
  });

  it('sends no About for an instrumental Session when the vocal pick is untouched', async () => {
    await createPerson(testDb.db as Database, {
      ownerUserId: holder.ownerUserId!,
      name: 'Julia',
      about: 'repairs bicycles',
    });
    const sessionId = await createSession(testDb.db, {
      ownerUserId: holder.ownerUserId!,
      styleSnapshot: { ...SEEDED, vocalMode: 'instrumental', voiceGender: '', lyricContext: '' },
      userPrompt: 'calm piano for Julia',
      title: 'Neon Nights',
    });

    const calls = await callsDuring(() =>
      changeVibeOk(sessionId, { mode: 'picks', energy: 'high' }),
    );

    const listener = calls[0]!.args[1] as { people?: unknown; about?: string } | null;
    expect(listener?.people).toBeUndefined();
    expect(listener?.about).toBeUndefined();
  });

  it('keeps the running language when Auto Detect is the only change and nothing names one', async () => {
    const sessionId = await seededSession();

    await changeVibeOk(sessionId, { mode: 'picks', language: 'auto' });

    expect((await loadSession(sessionId)).sessionStyleSnapshot?.language).toBe('German');
  });

  it('refuses picks with nothing to adjust when the current style cannot be read', async () => {
    const sessionId = await seededSession();
    await testDb.pool.query(
      `update activity_sessions set session_style_snapshot = '{"stylePrompt": 7}'::jsonb where id = $1`,
      [sessionId],
    );
    const before = await loadSession(sessionId);

    let res!: Response;
    const calls = await callsDuring(async () => {
      res = await changeVibe(sessionId, { mode: 'picks', energy: 'high' });
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: 'validation_error', message: expect.stringMatching(/in words/) },
    });
    expect(calls).toEqual([]);
    expect((await loadSession(sessionId)).styleRevision).toBe(before.styleRevision);
  });

  it('refuses a picks intent that carries no pick', async () => {
    const sessionId = await seededSession();
    for (const input of [{ mode: 'picks' }, { mode: 'picks', genres: [] }]) {
      expect((await changeVibe(sessionId, input)).status).toBe(400);
    }
  });
});

describe.skipIf(skip)('POST /api/sessions/change-vibe — picks only, no writing AI', () => {
  it('applies the pick to the current style text and takes nothing from the history', async () => {
    holder.llmConfigured = false;
    const sessionId = await startSession({ mode: 'prompt', prompt: 'calm piano for reading' });
    await changeVibeOk(sessionId, { mode: 'prompt', prompt: 'make it rockier' });
    const before = await loadSession(sessionId);

    const calls = await callsDuring(() =>
      changeVibeOk(sessionId, { mode: 'picks', energy: 'high' }),
    );

    expect(calls).toEqual([]);
    const after = await loadSession(sessionId);
    expect(after.sessionStyleSnapshot?.stylePrompt).toBe(
      `${before.sessionStyleSnapshot!.stylePrompt}, high energy`,
    );
    expect(after.userPrompt).toBe(before.userPrompt);
  });

  it('lets an Instrumental pick clear the vocal-only facets and keep the rest', async () => {
    holder.llmConfigured = false;
    const sessionId = await seededSession();

    await changeVibeOk(sessionId, { mode: 'picks', vocal: 'instrumental' });

    expect((await loadSession(sessionId)).sessionStyleSnapshot).toMatchObject({
      stylePrompt: 'warm synthwave, night drive, instrumental',
      vocalMode: 'instrumental',
      negativeTerms: ['vocals'],
      lyricContext: '',
      voiceGender: '',
      genreTags: ['synthwave'],
      bpm: 104,
      key: 'F minor',
      title: 'Neon Nights',
    });
  });

  it('keeps the running language on Auto Detect, with nothing to detect it from', async () => {
    holder.llmConfigured = false;
    const sessionId = await seededSession();

    await changeVibeOk(sessionId, { mode: 'picks', language: 'auto' });

    expect((await loadSession(sessionId)).sessionStyleSnapshot?.language).toBe('German');
  });

  it('lets the Any voice pick clear the running voice and keep the rest', async () => {
    holder.llmConfigured = false;
    const sessionId = await seededSession();

    await changeVibeOk(sessionId, { mode: 'picks', vocal: 'vocal', voice: 'any' });

    expect((await loadSession(sessionId)).sessionStyleSnapshot).toMatchObject({
      vocalMode: 'vocal',
      voiceGender: '',
      language: 'German',
      lyricContext: 'scene: rooftop at dusk',
    });
  });
});

describe.skipIf(skip)('POST /api/sessions/change-vibe — the Any voice, with a writing AI', () => {
  it('does not carry the running voice into the new revision', async () => {
    const sessionId = await seededSession();

    await changeVibeOk(sessionId, { mode: 'picks', vocal: 'vocal', voice: 'any' });

    expect((await loadSession(sessionId)).sessionStyleSnapshot?.voiceGender).toBe('');
  });
});
