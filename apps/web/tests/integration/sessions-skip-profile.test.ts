import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from 'graphile-worker';
import { startSessionResponseSchema } from '@liedmotif/shared';
import { createPerson, getSessionById, type Database } from '@liedmotif/db';
import {
  connectTestDb,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// Start-without-profile (the home-page toggle): everything that is the owner's
// own — their listener profile, their About, their Person — stays OUT of the
// session's LLM prompts. The request is the creative direction, including
// request-derived lyricContext for vocal sessions and the People it names.
// The flag persists on the session row, so Change Vibe re-derivations keep
// honoring it without the client resending anything.

const holder = vi.hoisted(() => ({
  db: null as unknown,
  ownerUserId: null as string | null,
  /** The personalization context every expansion was handed, newest last. */
  expansions: [] as { listener: unknown; skipProfile: boolean | undefined }[],
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
// Hermetic providers: the MOCK text LLM (deterministic listener/request lyric
// notes) and the mock music provider — no network, no spend. The LLM sits behind
// a capturing stub, so a test can assert what personalization context reached the
// model rather than inferring it from the notes the mock happened to write.
vi.mock('@/lib/providers/providers', async () => {
  const { mockLlmProvider, mockMusicProvider } = await import('@liedmotif/providers');
  const music = mockMusicProvider();
  const llm = mockLlmProvider();
  const capturing: typeof llm = {
    ...llm,
    async expandSessionIntentWithMetadata(intent, listener, picks, options) {
      holder.expansions.push({ listener: listener ?? null, skipProfile: options?.skipProfile });
      return llm.expandSessionIntentWithMetadata(intent, listener, picks, options);
    },
  };
  return {
    getLlmProvider: async () => capturing,
    getMusicProvider: () => music,
  };
});

const { POST: startRoute } = await import('@/app/api/sessions/route');
const { POST: changeVibeRoute } = await import('@/app/api/sessions/change-vibe/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

// The mock LLM turns a listener profile into `people: <name>` lyric notes and a
// skip-profile expansion into request-derived `story moments: …` notes — so the
// snapshot's lyricContext observably proves which context reached the LLM.
const VOCAL_PROMPT = 'sing a gentle song about the sea';

function post(route: (request: Request) => Promise<Response>, body: unknown) {
  return route(
    new Request('http://localhost/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function startVocalSession(extras: Record<string, unknown> = {}): Promise<string> {
  const res = await post(startRoute, {
    input: { mode: 'prompt', prompt: VOCAL_PROMPT },
    clientId: 'skip-profile-test',
    ...extras,
  });
  const parsed = startSessionResponseSchema.parse(await res.json());
  if (!parsed.ok) throw new Error('session start failed');
  return parsed.data.session.id;
}

async function readSession(sessionId: string) {
  const session = await getSessionById(testDb.db as Database, {
    ownerUserId: holder.ownerUserId!,
    sessionId,
  });
  if (!session) throw new Error('session not found');
  return session;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('sessions-skip-profile-test');
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
});

describe.skipIf(skip)('POST /api/sessions — start without profile', () => {
  it('keeps the listener profile out of the expansion and persists the flag', async () => {
    const sessionId = await startVocalSession({ skipProfile: true });

    const session = await readSession(sessionId);
    expect(session.skipProfile).toBe(true);
    // Request-derived lyric notes — never the profile ('Test Admin').
    expect(session.sessionStyleSnapshot?.lyricContext).toContain(VOCAL_PROMPT);
    expect(session.sessionStyleSnapshot?.lyricContext).not.toContain('Test Admin');
  });

  it('keeps the People the request names, without anything of the owner’s own', async () => {
    await createPerson(testDb.db as Database, {
      ownerUserId: holder.ownerUserId!,
      name: 'Julia',
      about: 'repairs bicycles',
    });

    await post(startRoute, {
      input: { mode: 'prompt', prompt: 'sing a birthday song for Julia' },
      clientId: 'skip-profile-test',
      skipProfile: true,
    });

    expect(holder.expansions.at(-1)).toEqual({
      listener: { people: [{ name: 'Julia', about: 'repairs bicycles' }] },
      skipProfile: true,
    });
  });

  it('personalizes from the listener profile by default', async () => {
    const sessionId = await startVocalSession();

    const session = await readSession(sessionId);
    expect(session.skipProfile).toBe(false);
    expect(session.sessionStyleSnapshot?.lyricContext).toContain('Test Admin');
  });

  it('Change Vibe keeps honoring the stored flag without the client resending it', async () => {
    const sessionId = await startVocalSession({ skipProfile: true });

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: 'sing about rain on rooftops' },
    });
    expect(res.status).toBe(200);

    // The stored flag reaches the expansion, and the profile does not — asserted
    // on the call itself, since an adjustment's notes come from the running
    // session either way and could not tell the two apart.
    expect(holder.expansions.at(-1)).toEqual({ listener: null, skipProfile: true });
    const session = await readSession(sessionId);
    expect(session.skipProfile).toBe(true);
    expect(session.sessionStyleSnapshot?.lyricContext).not.toContain('Test Admin');
  });

  it('sends the listener profile with the Change Vibe of a default session', async () => {
    const sessionId = await startVocalSession();

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: 'sing about rain on rooftops' },
    });
    expect(res.status).toBe(200);

    expect(holder.expansions.at(-1)).toMatchObject({
      listener: { name: 'Test Admin' },
      skipProfile: false,
    });
  });
});
