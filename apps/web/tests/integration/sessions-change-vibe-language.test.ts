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

// Change Vibe with fine-tune picks:
// explicit picks are authoritative over the message text, the stored session
// language is carried forward ONLY for pick-less intents (a server-side
// fallback, never an override), an existing session Name survives a vibe
// change, and a successful change enqueues the buffer job so the first
// new-vibe generation does not wait for the minute sweep.

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
// Hermetic providers: the MOCK text LLM (deterministic, enforces picks) and the
// mock music provider — no network, no spend.
vi.mock('@/lib/providers', async () => {
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

async function startGermanSession(): Promise<string> {
  const res = await post(startRoute, {
    input: { mode: 'controls', controls: { mood: 'calm', energy: 'low', language: 'German' } },
    clientId: 'change-vibe-language-test',
  });
  const parsed = startSessionResponseSchema.parse(await res.json());
  if (!parsed.ok) throw new Error('session start failed');
  return parsed.data.session.id;
}

async function sessionLanguage(sessionId: string): Promise<string | undefined> {
  const session = await getSessionById(testDb.db as Database, {
    ownerUserId: holder.ownerUserId!,
    sessionId,
  });
  return session?.sessionStyleSnapshot?.language;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('sessions-change-vibe-language-test');
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

describe.skipIf(skip)('POST /api/sessions/change-vibe — language carry-forward', () => {
  it('carries the session language through a controls vibe change with no language', async () => {
    const sessionId = await startGermanSession();
    expect(await sessionLanguage(sessionId)).toBe('German');

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'controls', controls: { mood: 'stormy', energy: 'high' } },
    });
    expect(res.status).toBe(200);
    expect(await sessionLanguage(sessionId)).toBe('German');
  });

  it('carries the session language through a free-text vibe change', async () => {
    const sessionId = await startGermanSession();

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: 'ocean waves at dawn' },
    });
    expect(res.status).toBe(200);
    expect(await sessionLanguage(sessionId)).toBe('German');
  });

  it('lets an explicit controls language override the carried one', async () => {
    const sessionId = await startGermanSession();

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'controls', controls: { mood: 'stormy', language: 'French' } },
    });
    expect(res.status).toBe(200);
    expect(await sessionLanguage(sessionId)).toBe('French');
  });

  it('lets an explicit prompt-branch language pick beat the carried language', async () => {
    const sessionId = await startGermanSession();

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: 'ocean waves at dawn', language: 'French' },
    });
    expect(res.status).toBe(200);
    expect(await sessionLanguage(sessionId)).toBe('French');
  });

  it('an explicit Auto Detect releases the running language on both branches', async () => {
    for (const input of [
      { mode: 'prompt', prompt: 'ocean waves at dawn', language: 'auto' },
      { mode: 'controls', controls: { mood: 'stormy', language: 'auto' } },
    ]) {
      const sessionId = await startGermanSession();
      const res = await post(changeVibeRoute, { sessionId, input });
      expect(res.status).toBe(200);
      expect(await sessionLanguage(sessionId)).toBe('');
      // The marker is a Change Vibe instruction, never a stored control value.
      expect((await getSession(sessionId)).structuredControls?.language).toBeUndefined();
    }
  });

  it('Auto Detect re-detects from the request, which may resolve a language again', async () => {
    const sessionId = await startGermanSession();

    const res = await post(changeVibeRoute, {
      sessionId,
      input: {
        mode: 'prompt',
        prompt: 'ruhige Lieder mit Gesang',
        vocal: 'vocal',
        language: 'auto',
      },
    });
    expect(res.status).toBe(200);
    expect(await sessionLanguage(sessionId)).toBe('German');
  });

  it('leaves a language-less session language-less (nothing to carry)', async () => {
    const res = await post(startRoute, {
      input: { mode: 'controls', controls: { mood: 'calm' } },
      clientId: 'change-vibe-language-test',
    });
    const parsed = startSessionResponseSchema.parse(await res.json());
    if (!parsed.ok) throw new Error('session start failed');
    const sessionId = parsed.data.session.id;

    await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'controls', controls: { mood: 'stormy' } },
    });
    expect(await sessionLanguage(sessionId)).toBe('');
  });
});

async function getSession(sessionId: string) {
  const session = await getSessionById(testDb.db as Database, {
    ownerUserId: holder.ownerUserId!,
    sessionId,
  });
  if (!session) throw new Error('expected the session to exist');
  return session;
}

describe.skipIf(skip)('POST /api/sessions/change-vibe — picks, name, and the buffer kick', () => {
  it('explicit fine-tune picks are authoritative in the re-derived snapshot', async () => {
    const sessionId = await startGermanSession();

    const res = await post(changeVibeRoute, {
      sessionId,
      input: {
        mode: 'prompt',
        prompt: 'smoky late-night bar',
        genres: ['jazz'],
        energy: 'low',
        vocal: 'vocal',
        voice: 'male',
      },
    });
    expect(res.status).toBe(200);
    const snapshot = (await getSession(sessionId)).sessionStyleSnapshot!;
    expect(snapshot.genreTags?.[0]).toBe('jazz');
    expect(snapshot.energy).toBe('low');
    expect(snapshot.vocalMode).toBe('vocal');
    expect(snapshot.voiceGender).toBe('male');
    // No language pick sent — the session's language still carries.
    expect(snapshot.language).toBe('German');
  });

  it('keeps the snapshot naming across a vibe change (an adjustment, not a restart)', async () => {
    const sessionId = await startGermanSession();
    const before = (await getSession(sessionId)).sessionStyleSnapshot!;
    expect(before.title?.length).toBeGreaterThan(0);
    expect(before.trackTitles?.length).toBeGreaterThan(0);

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: 'a bit faster and warmer' },
    });
    expect(res.status).toBe(200);
    const after = (await getSession(sessionId)).sessionStyleSnapshot!;
    expect(after.title).toBe(before.title);
    expect(after.trackTitles).toEqual(before.trackTitles);
  });

  it('keeps an existing session Name across a vibe change (the Name is identity)', async () => {
    const sessionId = await startGermanSession();
    await testDb.pool.query(`update activity_sessions set title = 'Kept Name' where id = $1`, [
      sessionId,
    ]);

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'controls', controls: { mood: 'stormy', energy: 'high' } },
    });
    expect(res.status).toBe(200);
    expect((await getSession(sessionId)).title).toBe('Kept Name');
  });

  it('never writes the Name, even on a still-unnamed session', async () => {
    const sessionId = await startGermanSession();
    await testDb.pool.query(`update activity_sessions set title = null where id = $1`, [sessionId]);

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'controls', controls: { mood: 'stormy', energy: 'high' } },
    });
    expect(res.status).toBe(200);
    expect((await getSession(sessionId)).title).toBeNull();
  });

  it('switchImmediately arms the vibe switch at the newly minted revision', async () => {
    const sessionId = await startGermanSession();

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'controls', controls: { mood: 'stormy' } },
      switchImmediately: true,
    });
    expect(res.status).toBe(200);
    const session = await getSession(sessionId);
    expect(session.vibeSwitchRevision).toBe(session.styleRevision);

    // An untoggled follow-up change supersedes the armed switch.
    await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'controls', controls: { mood: 'gentle' } },
    });
    expect((await getSession(sessionId)).vibeSwitchRevision).toBeNull();
  });

  it('enqueues the session buffer job so the new vibe generates without the sweep', async () => {
    const sessionId = await startGermanSession();
    await testDb.pool.query('delete from graphile_worker._private_jobs');

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'controls', controls: { mood: 'stormy' } },
    });
    expect(res.status).toBe(200);
    const { rows } = await testDb.pool.query(
      `select count(*)::int as n from graphile_worker._private_jobs where key = $1`,
      [`buffer:${sessionId}`],
    );
    expect(rows[0].n).toBe(1);
  });
});
