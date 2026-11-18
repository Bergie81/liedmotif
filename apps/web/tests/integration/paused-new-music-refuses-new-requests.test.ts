import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from 'graphile-worker';
import {
  proposeSurpriseResponseSchema,
  resumeSessionResponseSchema,
  startSessionResponseSchema,
} from '@liedmotif/shared';
import {
  getPendingProposal,
  getSessionById,
  updateUsageLimits,
  user,
  userProfiles,
  type Database,
} from '@liedmotif/db';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createSession,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// "Pause all new music" stops the worker buying any music on the Instance, so
// every request that exists only to start new music is refused up front: no
// text-LLM call, no row, no creation budget taken. What is already there —
// Resume, the Library — stays open.

const holder = vi.hoisted(() => ({
  db: null as unknown,
  ownerUserId: null as string | null,
  /** Every reach for the text LLM: no derivation, naming or suggestion without one. */
  llmProviderRequests: 0,
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
    getLlmProvider: async () => {
      holder.llmProviderRequests += 1;
      return llm;
    },
    getMusicProvider: () => music,
    getStorageProvider: () => ({ stat: async () => null }),
  };
});

const { POST: startRoute } = await import('@/app/api/sessions/route');
const { POST: moreLikeThisRoute } = await import('@/app/api/sessions/more-like-this/route');
const { POST: changeVibeRoute } = await import('@/app/api/sessions/change-vibe/route');
const { POST: resumeRoute } = await import('@/app/api/sessions/resume/route');
const { POST: proposeRoute } = await import('@/app/api/surprise-me/route');
const { POST: startSurpriseRoute } = await import('@/app/api/surprise-me/start/route');
const { sessionCreateLimiter } = await import('@/lib/request-limits');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;
const db = () => testDb.db as Database;

const ADMIN_PAUSED = 'New music is paused in Settings › Generation.';

async function post(route: (request: Request) => Promise<Response>, body: unknown) {
  return route(
    new Request('http://localhost/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function refusal(response: Response) {
  const body = (await response.json()) as {
    ok: boolean;
    error?: { code: string; message: string };
  };
  if (body.ok || !body.error) throw new Error('expected a refusal');
  return body.error;
}

async function setPaused(paused: boolean, extra: Parameters<typeof updateUsageLimits>[1] = {}) {
  await updateUsageLimits(db(), {
    dailyGenerationTasks: 50,
    monthlyGenerationTasks: 400,
    minHeadroomTracksToStartSession: 2,
    resetTimezone: 'UTC',
    ...extra,
    manualGenerationOnly: paused,
  });
}

async function startSession(): Promise<string> {
  const response = await post(startRoute, {
    input: { mode: 'prompt', prompt: 'calm music for late-night coding' },
    clientId: 'paused-new-music-test',
  });
  const parsed = startSessionResponseSchema.parse(await response.json());
  if (!parsed.ok) throw new Error(`session start failed: ${parsed.error.code}`);
  return parsed.data.session.id;
}

async function sessionCount(): Promise<number> {
  const { rows } = await testDb.pool.query<{ n: string }>(
    'select count(*)::text as n from activity_sessions',
  );
  return Number(rows[0]!.n);
}

async function seedTrack(ownerUserId: string): Promise<string> {
  const sessionId = await createSession(db(), {
    ownerUserId,
    status: 'stopped',
    styleSnapshot: { genreTags: ['lofi'], energy: 'low', vocalMode: 'instrumental' },
  });
  const generationRequestId = await createGenerationRequest(db(), {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const providerJobId = await createProviderJob(db(), { generationRequestId });
  return createTrack(db(), { ownerUserId, generationRequestId, providerJobId });
}

let limiterChecks: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('paused-new-music-refuses-new-requests-test');
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
  await setPaused(false);
  limiterChecks?.mockRestore();
  limiterChecks = vi.spyOn(sessionCreateLimiter, 'check');
});

/** Everything a refused request must have left alone. */
function expectNothingSpent() {
  expect(holder.llmProviderRequests).toBe(0);
  expect(limiterChecks).not.toHaveBeenCalled();
}

describe.skipIf(skip)('Pause all new music — new requests are refused before any spend', () => {
  it('refuses a Start: no Session row, the Active Session stays, no text LLM', async () => {
    const activeId = await startSession();
    await setPaused(true);
    const before = await sessionCount();
    holder.llmProviderRequests = 0;
    limiterChecks.mockClear();

    const response = await post(startRoute, {
      input: { mode: 'prompt', prompt: 'hard techno' },
      clientId: 'paused-new-music-test',
    });

    expect(await refusal(response)).toMatchObject({
      code: 'new_music_paused',
      message: ADMIN_PAUSED,
    });
    expect(await sessionCount()).toBe(before);
    const active = await getSessionById(db(), {
      ownerUserId: holder.ownerUserId!,
      sessionId: activeId,
    });
    expect(active?.status).toBe('active');
    expectNothingSpent();
  });

  it('shows the pause, not the budget, when both refuse', async () => {
    await setPaused(true, { dailyGenerationTasks: 0 });

    const response = await post(startRoute, {
      input: { mode: 'prompt', prompt: 'hard techno' },
      clientId: 'paused-new-music-test',
    });

    expect((await refusal(response)).code).toBe('new_music_paused');
  });

  it('tells a Member who paused it, never a settings page', async () => {
    await testDb.db.insert(user).values({ id: 'admin-1', name: 'Thomas', email: 'a@example.test' });
    await testDb.db.insert(userProfiles).values({ userId: 'admin-1', role: 'admin' });
    await testDb.db.insert(user).values({ id: 'member-1', name: 'Mia', email: 'm@example.test' });
    await testDb.db.insert(userProfiles).values({ userId: 'member-1', role: 'member' });
    holder.ownerUserId = 'member-1';
    await setPaused(true);

    const response = await post(startRoute, {
      input: { mode: 'prompt', prompt: 'hard techno' },
      clientId: 'paused-new-music-test',
    });

    expect(await refusal(response)).toMatchObject({
      code: 'new_music_paused',
      message: 'Thomas has paused new music.',
    });
  });

  it('refuses More Like This without naming the new Session', async () => {
    const seedTrackId = await seedTrack(holder.ownerUserId!);
    await setPaused(true);
    const before = await sessionCount();

    const response = await post(moreLikeThisRoute, {
      seedTrackIds: [seedTrackId],
      clientId: 'paused-new-music-test',
    });

    expect((await refusal(response)).code).toBe('new_music_paused');
    expect(await sessionCount()).toBe(before);
    expectNothingSpent();
  });

  it('refuses Change Vibe: no revision is minted and the prompt history is unchanged', async () => {
    const sessionId = await startSession();
    await setPaused(true);
    const before = await getSessionById(db(), { ownerUserId: holder.ownerUserId!, sessionId });
    holder.llmProviderRequests = 0;
    limiterChecks.mockClear();

    const response = await post(changeVibeRoute, {
      sessionId,
      input: { mode: 'prompt', prompt: 'hard techno' },
      switchImmediately: true,
    });

    expect(await refusal(response)).toMatchObject({
      code: 'new_music_paused',
      message: ADMIN_PAUSED,
    });
    const after = await getSessionById(db(), { ownerUserId: holder.ownerUserId!, sessionId });
    expect(after?.styleRevision).toBe(before?.styleRevision);
    expect(after?.userPrompt).toBe(before?.userPrompt);
    expectNothingSpent();
  });

  it('refuses a Surprise Me proposal, a "Try another" and a Start, and keeps the suggestion pending', async () => {
    const proposed = proposeSurpriseResponseSchema.parse(
      await (await post(proposeRoute, { replaces: null })).json(),
    );
    if (!proposed.ok) throw new Error(`proposal refused: ${proposed.error.code}`);
    const proposalId = proposed.data.proposal.id;
    await setPaused(true);
    holder.llmProviderRequests = 0;
    limiterChecks.mockClear();
    const before = await sessionCount();

    const another = await post(proposeRoute, { replaces: proposalId });
    expect((await refusal(another)).code).toBe('new_music_paused');

    const started = await post(startSurpriseRoute, { proposalId });
    expect((await refusal(started)).code).toBe('new_music_paused');

    expect((await getPendingProposal(db(), holder.ownerUserId!))?.id).toBe(proposalId);
    expect(await sessionCount()).toBe(before);
    expectNothingSpent();
  });

  it('keeps Resume open', async () => {
    const sessionId = await createSession(db(), {
      ownerUserId: holder.ownerUserId!,
      status: 'stopped',
    });
    await setPaused(true);

    const response = await post(resumeRoute, { sessionId, clientId: 'paused-new-music-test' });

    const parsed = resumeSessionResponseSchema.parse(await response.json());
    expect(parsed.ok).toBe(true);
  });
});
