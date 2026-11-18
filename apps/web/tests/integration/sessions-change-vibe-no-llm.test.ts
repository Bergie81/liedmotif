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

// Change Vibe without a text LLM: the sheet has no LLM awareness, so a change
// on a prompt-born vibe must derive deterministically through the same
// passthrough seam the create path uses — a real revision with the
// guardrail/pick carry rules and the preserved naming intact, never an error
// and never an LLM call.

const holder = vi.hoisted(() => ({
  db: null as unknown,
  ownerUserId: null as string | null,
  llmConfigured: false,
  llmInvocations: 0,
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
// Hermetic providers: the mock music provider, and an LLM the seam hands out
// only when a test says one is configured. Every method of the ONE provider
// instance this module graph can produce counts an invocation, so "zero LLM
// calls" is asserted at the provider seam — a stale cached reference would be
// counted too, not just a fresh `getLlmProvider` resolution.
vi.mock('@/lib/providers', async () => {
  const { mockLlmProvider, mockMusicProvider } = await import('@liedmotif/providers');
  const music = mockMusicProvider();
  const real = mockLlmProvider();
  const llm = Object.fromEntries(
    Object.entries(real).map(([key, value]) => [
      key,
      typeof value === 'function'
        ? (...args: unknown[]) => {
            holder.llmInvocations += 1;
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
  const res = await post(startRoute, { input, clientId: 'change-vibe-no-llm-test' });
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

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('sessions-change-vibe-no-llm-test');
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
  holder.llmConfigured = false;
  holder.llmInvocations = 0;
});

describe.skipIf(skip)('POST /api/sessions/change-vibe — no text LLM configured', () => {
  it('re-derives a free-text change deterministically: revision, history, guardrails, picks', async () => {
    const sessionId = await startSession({
      mode: 'prompt',
      prompt: ORIGIN,
      styleStrength: 0.9,
      novelty: 0.05,
      avoid: 'saxophone',
    });
    const before = await loadSession(sessionId);

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: 'mehr rockiger', genres: ['techno'] },
    });
    expect(res.status).toBe(200);

    const after = await loadSession(sessionId);
    // A real revision on the same session, its history extended by the message.
    expect(after.styleRevision).toBe(before.styleRevision + 1);
    expect(after.userPrompt).toBe(`${ORIGIN}\n\nmehr rockiger`);
    // The passthrough compiles the change text itself; the explicit pick wins.
    expect(after.sessionStyleSnapshot?.stylePrompt).toContain('mehr rockiger');
    expect(after.sessionStyleSnapshot?.genreTags?.[0]).toBe('techno');
    // Untouched guardrails carry from the running snapshot, not the defaults.
    expect(after.sessionStyleSnapshot?.styleStrength).toBe(0.9);
    expect(after.sessionStyleSnapshot?.novelty).toBe(0.05);
    expect(after.sessionStyleSnapshot?.userAvoid).toBe('saxophone');
    expect(after.sessionStyleSnapshot?.negativeTerms).toEqual(['vocals', 'saxophone']);
    // The Name is identity and never touched.
    expect(after.title).toBe(before.title);
    expect(holder.llmInvocations).toBe(0);
  });

  it('applies a picks-only change to the current style, leaving the history alone', async () => {
    const sessionId = await startSession({ mode: 'prompt', prompt: ORIGIN });
    const before = await loadSession(sessionId);

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'picks', energy: 'high' },
    });
    expect(res.status).toBe(200);

    const after = await loadSession(sessionId);
    expect(after.styleRevision).toBe(before.styleRevision + 1);
    expect(after.sessionStyleSnapshot?.energy).toBe('high');
    expect(after.sessionStyleSnapshot?.stylePrompt).toBe(
      `${before.sessionStyleSnapshot!.stylePrompt}, high energy`,
    );
    expect(after.userPrompt).toBe(ORIGIN);
    expect(holder.llmInvocations).toBe(0);
  });

  it('keeps the session naming a text LLM once wrote, after the LLM is removed', async () => {
    const sessionId = await startSession({ mode: 'prompt', prompt: ORIGIN });
    // A session an LLM named while it was configured: creative title, a track
    // -title pool, and vocal lyric notes live in the stored snapshot.
    await testDb.pool.query(
      `update activity_sessions
         set session_style_snapshot = session_style_snapshot || $2::jsonb
       where id = $1`,
      [
        sessionId,
        JSON.stringify({
          title: 'Neon Nights',
          trackTitles: ['Neon Nights Dawn', 'Neon Nights Drift'],
          lyricContext: 'people: Ada',
          vocalMode: 'vocal',
        }),
      ],
    );

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: 'more synthwave', vocal: 'vocal' },
    });
    expect(res.status).toBe(200);

    const snapshot = (await loadSession(sessionId)).sessionStyleSnapshot;
    expect(snapshot?.title).toBe('Neon Nights');
    expect(snapshot?.trackTitles).toEqual(['Neon Nights Dawn', 'Neon Nights Drift']);
    expect(snapshot?.lyricContext).toBe('people: Ada');
    expect(holder.llmInvocations).toBe(0);
  });

  // A vocal pop Session sung by a female voice: every facet a message or a
  // single pick leaves alone must survive the change.
  const VOCAL_POP = {
    mode: 'prompt',
    prompt: 'summer road trip pop',
    genres: ['pop'],
    vocal: 'vocal',
    voice: 'female',
  } as const;

  it('anchors a message-only change on the running vibe: vocals, voice, genres and bpm/key stay', async () => {
    const sessionId = await startSession(VOCAL_POP);
    const before = (await loadSession(sessionId)).sessionStyleSnapshot!;

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: 'slower and dreamier' },
    });
    expect(res.status).toBe(200);

    const after = (await loadSession(sessionId)).sessionStyleSnapshot!;
    expect(after.stylePrompt).toContain('slower and dreamier');
    // The genre reaches the music model only through the style text.
    expect(after.stylePrompt).toContain('pop');
    expect(after.vocalMode).toBe('vocal');
    expect(after.voiceGender).toBe('female');
    expect(after.genreTags).toEqual(['pop']);
    expect(after.negativeTerms).not.toContain('vocals');
    expect(after.bpm).toBe(before.bpm);
    expect(after.key).toBe(before.key);
    expect(holder.llmInvocations).toBe(0);
  });

  it('keeps vocals and genres through a picks-only energy change and re-freezes only the tempo', async () => {
    const sessionId = await startSession(VOCAL_POP);
    const before = (await loadSession(sessionId)).sessionStyleSnapshot!;

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'picks', energy: 'high' },
    });
    expect(res.status).toBe(200);

    const after = (await loadSession(sessionId)).sessionStyleSnapshot!;
    expect(after.energy).toBe('high');
    expect(after.vocalMode).toBe('vocal');
    expect(after.voiceGender).toBe('female');
    expect(after.genreTags).toEqual(['pop']);
    expect(after.bpm!).toBeGreaterThan(before.bpm!);
    expect(after.key).toBe(before.key);
  });

  it('still switches to instrumental on an explicit pick, clearing the lyric notes', async () => {
    const sessionId = await startSession(VOCAL_POP);
    await testDb.pool.query(
      `update activity_sessions
         set session_style_snapshot = session_style_snapshot || $2::jsonb
       where id = $1`,
      [sessionId, JSON.stringify({ lyricContext: 'people: Ada' })],
    );

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: 'slower and dreamier', vocal: 'instrumental' },
    });
    expect(res.status).toBe(200);

    const after = (await loadSession(sessionId)).sessionStyleSnapshot!;
    expect(after.vocalMode).toBe('instrumental');
    expect(after.voiceGender).toBe('');
    expect(after.lyricContext).toBe('');
    expect(after.negativeTerms).toEqual(['vocals']);
    expect(after.genreTags).toEqual(['pop']);
  });

  it('still routes a picks-only change on a controls-born vibe through the controls merge', async () => {
    const sessionId = await startSession({
      mode: 'controls',
      controls: { mood: 'calm', energy: 'low', vocal: 'instrumental' },
    });

    // The sheet's WYSIWYG controls merge: the stored controls with the edits.
    const res = await post(changeVibeRoute, {
      sessionId,
      input: {
        mode: 'controls',
        controls: { mood: 'calm', energy: 'high', vocal: 'instrumental' },
      },
    });
    expect(res.status).toBe(200);

    const after = await loadSession(sessionId);
    expect(after.sessionStyleSnapshot?.energy).toBe('high');
    expect(after.sessionStyleSnapshot?.vocalMode).toBe('instrumental');
    expect(after.structuredControls).toEqual({
      mood: 'calm',
      energy: 'high',
      vocal: 'instrumental',
    });
    // A controls change never touches the prompt history.
    expect(after.userPrompt).toBeNull();
    expect(holder.llmInvocations).toBe(0);
  });

  it('uses a configured LLM for the same change — passthrough is never a silent bypass', async () => {
    holder.llmConfigured = true;
    const sessionId = await startSession({ mode: 'prompt', prompt: ORIGIN });

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: 'mehr rockiger' },
    });
    expect(res.status).toBe(200);
    // Also proves the zero-call assertions above have teeth: the same counter
    // that must stay at zero without an LLM moves when one is configured.
    expect(holder.llmInvocations).toBeGreaterThan(0);
  });

  it('arms switchImmediately at the revision the no-LLM derive mints, and a plain change clears it', async () => {
    const sessionId = await startSession({ mode: 'prompt', prompt: ORIGIN });

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: 'hard techno now' },
      switchImmediately: true,
    });
    expect(res.status).toBe(200);
    const armed = await loadSession(sessionId);
    expect(armed.vibeSwitchRevision).toBe(armed.styleRevision);

    await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: 'and slower again' },
    });
    expect((await loadSession(sessionId)).vibeSwitchRevision).toBeNull();
    expect(holder.llmInvocations).toBe(0);
  });
  it('preserves the total target through creative edits and honors explicit replacement and clearing', async () => {
    const sessionId = await startSession({ mode: 'prompt', prompt: ORIGIN });
    for (const target of [12, undefined, 480, null, undefined]) {
      const before = await loadSession(sessionId);
      const response = await post(changeVibeRoute, {
        sessionId,
        input: { mode: 'prompt', prompt: 'softer, for twenty minutes' },
        ...(target !== undefined ? { targetDurationMinutes: target } : {}),
      });
      expect(response.status).toBe(200);
      const after = await loadSession(sessionId);
      expect(after.targetDurationMinutes).toBe(
        target === undefined ? before.targetDurationMinutes : target,
      );
      expect(after.styleRevision).toBe(before.styleRevision + 1);
      expect(after.title).toBe(before.title);
    }
    expect(holder.llmInvocations).toBe(0);
  });
});
