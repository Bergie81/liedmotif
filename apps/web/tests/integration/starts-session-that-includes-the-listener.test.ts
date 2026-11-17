import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from 'graphile-worker';
import { startSessionResponseSchema } from '@liedmotif/shared';
import { ensureOwnerPerson, getSessionById, updatePerson, type Database } from '@liedmotif/db';
import {
  connectTestDb,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// A request can put the listener in its scene without their name ("sing about
// me and Julia"), which no exact-name match sees. The text LLM answers whether
// it does; the Session row keeps the answer for its generated cover, and the
// owner's own About rides to the expansion so the lyric notes can use it.

const holder = vi.hoisted(() => ({
  db: null as unknown,
  ownerUserId: null as string | null,
  /** What every expansion was handed, newest last. */
  expansions: [] as { listener: unknown; includesListener: boolean | undefined }[],
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
// Hermetic providers: the MOCK text LLM reads "me" as the listener being in the
// scene (its stand-in for a real model's judgment) — no network, no spend.
vi.mock('@/lib/providers', async () => {
  const { mockLlmProvider, mockMusicProvider } = await import('@liedmotif/providers');
  const music = mockMusicProvider();
  const llm = mockLlmProvider();
  const capturing: typeof llm = {
    ...llm,
    async expandSessionIntentWithMetadata(intent, listener, picks, options) {
      holder.expansions.push({
        listener: listener ?? null,
        includesListener: options?.includesListener,
      });
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

const OWN_ABOUT = 'Runs along the river in the rain.';

function post(route: (request: Request) => Promise<Response>, body: unknown) {
  return route(
    new Request('http://localhost/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function startSession(prompt: string, extras: Record<string, unknown> = {}) {
  const res = await post(startRoute, {
    input: { mode: 'prompt', prompt },
    clientId: 'includes-listener-test',
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
  testDb = await connectTestDb('includes-listener-test');
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
  const owner = await ensureOwnerPerson(testDb.db as Database, holder.ownerUserId);
  await updatePerson(testDb.db as Database, {
    ownerUserId: holder.ownerUserId,
    personId: owner.id,
    name: owner.name,
    about: OWN_ABOUT,
  });
  holder.expansions = [];
});

describe.skipIf(skip)('POST /api/sessions — a request that includes the listener', () => {
  it('keeps the answer on the Session and hands the expansion the owner’s own About', async () => {
    const sessionId = await startSession('sing a song about me on a trip to the moon');

    expect((await readSession(sessionId)).includesListener).toBe(true);
    expect(holder.expansions.at(-1)?.listener).toMatchObject({ about: OWN_ABOUT });
  });

  it('answers no for a request that only asks for music', async () => {
    const sessionId = await startSession('sing a gentle song about the sea');

    expect((await readSession(sessionId)).includesListener).toBe(false);
  });

  it('never includes the listener in a session started without the profile', async () => {
    const sessionId = await startSession('sing a song about me on a trip to the moon', {
      skipProfile: true,
    });

    expect((await readSession(sessionId)).includesListener).toBe(false);
    expect(holder.expansions.at(-1)?.listener).toBeNull();
  });

  it('Change Vibe starts from the stored answer and keeps it when the change says nothing', async () => {
    const sessionId = await startSession('sing a song about me on a trip to the moon');

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: 'a bit faster' },
    });
    expect(res.status).toBe(200);

    expect(holder.expansions.at(-1)?.includesListener).toBe(true);
    expect((await readSession(sessionId)).includesListener).toBe(true);
  });

  it('Change Vibe can put the listener into a session that started without them', async () => {
    const sessionId = await startSession('sing a gentle song about the sea');

    const res = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: 'put me in it too' },
    });
    expect(res.status).toBe(200);

    expect((await readSession(sessionId)).includesListener).toBe(true);
  });
});
