import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from 'graphile-worker';
import { startSessionResponseSchema } from '@liedmotif/shared';
import { getSessionById, updateCoverArtSettings, type Database } from '@liedmotif/db';
import {
  connectTestDb,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// The cover-source choice (standard covers from the music provider vs styled
// image-provider covers): an explicit request wins; the no-AI paths — hand-tuned
// (controls) sessions and no-LLM prompt passthrough — default to standard; and
// LLM-backed prompt sessions follow the owner's saved Settings → Cover art
// default. The choice persists on the session row — the worker's provider
// selection reads it from there.

const holder = vi.hoisted(() => ({
  db: null as unknown,
  ownerUserId: null as string | null,
  llmConfigured: true,
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
vi.mock('@/lib/providers', async () => {
  const { mockLlmProvider, mockMusicProvider } = await import('@liedmotif/providers');
  const music = mockMusicProvider();
  const llm = mockLlmProvider();
  return {
    getLlmProvider: async () => (holder.llmConfigured ? llm : null),
    getMusicProvider: () => music,
  };
});

const { POST: startRoute } = await import('@/app/api/sessions/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

async function startSession(body: Record<string, unknown>): Promise<string> {
  const res = await startRoute(
    new Request('http://localhost/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'cover-source-test', ...body }),
    }),
  );
  const parsed = startSessionResponseSchema.parse(await res.json());
  if (!parsed.ok) throw new Error('session start failed');
  return parsed.data.session.id;
}

async function loadSession(sessionId: string) {
  const session = await getSessionById(testDb.db as Database, {
    ownerUserId: holder.ownerUserId!,
    sessionId,
  });
  if (!session) throw new Error('session not found');
  return session;
}

async function sessionUsesStandardCover(sessionId: string): Promise<boolean> {
  return (await loadSession(sessionId)).useStandardCover;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('sessions-cover-source-test');
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
});

describe.skipIf(skip)('POST /api/sessions — cover-source choice', () => {
  it('defaults a prompt session to styled covers', async () => {
    const id = await startSession({ input: { mode: 'prompt', prompt: 'calm focus beats' } });
    await expect(sessionUsesStandardCover(id)).resolves.toBe(false);
  });

  it('persists an explicit standard-cover pick on a prompt session', async () => {
    const id = await startSession({
      input: { mode: 'prompt', prompt: 'calm focus beats' },
      useStandardCover: true,
    });
    await expect(sessionUsesStandardCover(id)).resolves.toBe(true);
  });

  it('defaults a hand-tuned (controls) session to standard covers', async () => {
    const id = await startSession({ input: { mode: 'controls', controls: {} } });
    await expect(sessionUsesStandardCover(id)).resolves.toBe(true);
  });

  it('lets an explicit pick override the hand-tuned default', async () => {
    const id = await startSession({
      input: { mode: 'controls', controls: {} },
      useStandardCover: false,
    });
    await expect(sessionUsesStandardCover(id)).resolves.toBe(false);
  });

  it('follows the saved Settings → Cover art default for prompt sessions', async () => {
    await updateCoverArtSettings(testDb.db as Database, holder.ownerUserId!, {
      useStandardCoverArt: true,
    });
    const id = await startSession({ input: { mode: 'prompt', prompt: 'calm focus beats' } });
    await expect(sessionUsesStandardCover(id)).resolves.toBe(true);
  });
});

// Without a text LLM the prompt compiles via the deterministic passthrough —
// the create succeeds end-to-end, and the no-AI default
// keeps the image model out too: standard covers unless explicitly chosen
// otherwise.
describe.skipIf(skip)('POST /api/sessions — no-LLM prompt passthrough', () => {
  it('creates the session end-to-end and defaults to standard covers', async () => {
    holder.llmConfigured = false;
    const id = await startSession({ input: { mode: 'prompt', prompt: 'warm analog synthwave' } });
    const session = await loadSession(id);
    expect(session.useStandardCover).toBe(true);
    expect(session.userPrompt).toBe('warm analog synthwave');
    expect(session.structuredControls).toBeNull();
    expect(session.sessionStyleSnapshot?.stylePrompt).toBe('warm analog synthwave');
    // No LLM ran, so the Name can only be the deterministic composition.
    expect(session.title?.trim()).toBeTruthy();
  });

  it('honors an explicit styled-cover pick without an LLM', async () => {
    holder.llmConfigured = false;
    const id = await startSession({
      input: { mode: 'prompt', prompt: 'warm analog synthwave' },
      useStandardCover: false,
    });
    await expect(sessionUsesStandardCover(id)).resolves.toBe(false);
  });
});
