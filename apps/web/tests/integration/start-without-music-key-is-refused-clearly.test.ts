// An Instance on the real music provider with no usable key — none anywhere, a
// stored one that cannot be read, or an unknown provider name — refuses every
// new Session with the error envelope and plain words, and refuses it before
// anything is created or spent. The provider resolution is the real one
// against the test database; only the text LLM is stood in for, so its reach
// can be counted, and the refusal comes before any provider request.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from 'graphile-worker';
import {
  DecryptionError,
  decodeEncryptionKey,
  EncryptionKeyError,
  getPendingProposal,
  getSessionById,
  updateUsageLimits,
  upsertProviderCredential,
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
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { ProviderConfigError } from '@liedmotif/providers';
import { proposeSurpriseResponseSchema, type AssistantCard } from '@liedmotif/shared';
import { askWithToolCalls, type ToolCallsTurn } from '../helpers/assistant-tool-turn';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  ownerUserId: null as string | null,
  llm: null as unknown,
  /** Every reach for the text LLM: a refused start makes none. */
  llmProviderRequests: 0,
  /** Stands in for the music provider build only where a test says so. */
  musicOverride: null as (() => Promise<unknown>) | null,
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
vi.mock('@/lib/auth/auth', () => ({
  getAuth: () => ({
    api: {
      getSession: async () =>
        holder.ownerUserId ? { session: { id: 'live' }, user: { id: holder.ownerUserId } } : null,
    },
  }),
}));
vi.mock('@/lib/providers/providers', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/providers/providers')>();
  return {
    ...real,
    getLlmProvider: async () => {
      holder.llmProviderRequests += 1;
      return holder.llm;
    },
    getMusicProvider: () => (holder.musicOverride ?? real.getMusicProvider)(),
  };
});

const { POST: startRoute } = await import('@/app/api/sessions/route');
const { POST: moreLikeThisRoute } = await import('@/app/api/sessions/more-like-this/route');
const { POST: proposeRoute } = await import('@/app/api/surprise-me/route');
const { POST: startSurpriseRoute } = await import('@/app/api/surprise-me/start/route');
const { POST: assistantRoute } = await import('@/app/api/assistant/route');
const { sessionCreateLimiter } = await import('@/lib/http/request-limits');
const { getMusicProvider } = await import('@/lib/providers/providers');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;
const db = () => testDb.db as Database;

const ADMIN_MESSAGE =
  "The music key is missing or can't be read. Enter it under Settings › AI Providers.";
const MEMBER_MESSAGE = "Music isn't set up on this server yet. Ask the Admin to set it up.";
/** The key a stored music credential is sealed with, and a different one it is read with. */
const SEAL_KEY_B64 = Buffer.alloc(32, 3).toString('base64');
const READ_KEY_B64 = Buffer.alloc(32, 9).toString('base64');
const STORED_SECRET = 'suno-stored-secret-7f3a';
const ENV_VARS = ['MUSIC_PROVIDER', 'SUNO_API_KEY', 'CREDENTIAL_ENCRYPTION_KEY'] as const;
const savedEnv: Partial<Record<string, string>> = {};

async function post(route: (request: Request) => Promise<Response>, body: unknown) {
  return route(
    new Request('http://localhost/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function refusalOf(response: Response) {
  const text = await response.text();
  const body = JSON.parse(text) as {
    ok: boolean;
    error?: { code: string; message: string; retryable: boolean };
  };
  if (body.ok || !body.error) throw new Error(`expected a refusal, got ${text}`);
  return { ...body.error, text };
}

function startBody(prompt = 'calm music for late-night coding') {
  return { input: { mode: 'prompt', prompt }, clientId: 'music-key-test' };
}

async function sessionCount(): Promise<number> {
  const { rows } = await testDb.pool.query<{ n: number }>(
    'select count(*)::int as n from activity_sessions',
  );
  return rows[0]!.n;
}

async function addUser(id: string, role: 'admin' | 'member'): Promise<string> {
  await testDb.db.insert(user).values({ id, name: id, email: `${id}@example.test` });
  await testDb.db.insert(userProfiles).values({ userId: id, role });
  return id;
}

/** A music credential saved in the app, sealed with `SEAL_KEY_B64`. */
async function storeMusicKey(): Promise<void> {
  await upsertProviderCredential(db(), {
    providerType: 'music',
    providerKey: 'suno',
    displayName: 'Suno',
    secret: STORED_SECRET,
    encryptionKey: decodeEncryptionKey(SEAL_KEY_B64),
  });
}

let limiterChecks: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('start-without-music-key-test');
  holder.db = testDb.db;
  await runMigrations({ connectionString: TEST_DATABASE_URL });
}, 60_000);
afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});
beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, [
    ...GENERATION_FIXTURE_TABLES,
    'provider_credentials',
    'surprise_proposals',
    'user_settings',
    'app_settings',
  ]);
  // Vitest loads `repo/.env`: the real provider, with no key anywhere, is this
  // file's own setup.
  for (const name of ENV_VARS) savedEnv[name] = process.env[name];
  process.env.MUSIC_PROVIDER = 'suno';
  delete process.env.SUNO_API_KEY;
  process.env.CREDENTIAL_ENCRYPTION_KEY = READ_KEY_B64;
  await updateUsageLimits(db(), {
    manualGenerationOnly: false,
    dailyGenerationTasks: 50,
    monthlyGenerationTasks: 400,
    minHeadroomTracksToStartSession: 2,
    resetTimezone: 'UTC',
  });
  holder.ownerUserId = await addUser(`admin-${randomUUID()}`, 'admin');
  holder.llm = null;
  holder.llmProviderRequests = 0;
  holder.musicOverride = null;
  limiterChecks?.mockRestore();
  limiterChecks = vi.spyOn(sessionCreateLimiter, 'check');
});
afterEach(() => {
  for (const name of ENV_VARS) {
    const saved = savedEnv[name];
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
});

/** The clear refusal, carrying no secret and no raw error text. */
function expectClearRefusal(refusal: Awaited<ReturnType<typeof refusalOf>>, message: string) {
  expect(refusal).toMatchObject({ code: 'provider_error', message, retryable: false });
  for (const leak of [
    STORED_SECRET,
    'SUNO_API_KEY',
    'Settings → Providers',
    'decrypt',
    'CREDENTIAL_ENCRYPTION_KEY',
    'Unknown music provider',
  ]) {
    expect(refusal.text).not.toContain(leak);
  }
}

/** Everything a refused request must have left alone. */
function expectNothingSpent() {
  expect(holder.llmProviderRequests).toBe(0);
  expect(limiterChecks).not.toHaveBeenCalled();
}

describe.skipIf(skip)('starting without a usable music key', () => {
  it('refuses Start Session with no key anywhere: no Session, the Active one stays, nothing spent', async () => {
    const activeId = await createSession(db(), { ownerUserId: holder.ownerUserId! });

    const response = await post(startRoute, startBody());

    expect(response.status).not.toBe(500);
    expectClearRefusal(await refusalOf(response), ADMIN_MESSAGE);
    expect(await sessionCount()).toBe(1);
    const active = await getSessionById(db(), {
      ownerUserId: holder.ownerUserId!,
      sessionId: activeId,
    });
    expect(active?.status).toBe('active');
    expectNothingSpent();
  });

  it('refuses a stored key that cannot be decrypted with the same words', async () => {
    await storeMusicKey();
    await expect(getMusicProvider()).rejects.toBeInstanceOf(DecryptionError);

    const response = await post(startRoute, startBody());

    expectClearRefusal(await refusalOf(response), ADMIN_MESSAGE);
    expect(await sessionCount()).toBe(0);
    expectNothingSpent();
  });

  it('refuses a stored key while no CREDENTIAL_ENCRYPTION_KEY is set', async () => {
    await storeMusicKey();
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    await expect(getMusicProvider()).rejects.toBeInstanceOf(EncryptionKeyError);

    const response = await post(startRoute, startBody());

    expectClearRefusal(await refusalOf(response), ADMIN_MESSAGE);
    expect(await sessionCount()).toBe(0);
  });

  it('refuses an unknown MUSIC_PROVIDER value', async () => {
    process.env.MUSIC_PROVIDER = 'sunno';
    await expect(getMusicProvider()).rejects.toBeInstanceOf(ProviderConfigError);

    const response = await post(startRoute, startBody());

    expectClearRefusal(await refusalOf(response), ADMIN_MESSAGE);
    expect(await sessionCount()).toBe(0);
  });

  it('tells a Member that music is not set up and to ask the Admin', async () => {
    holder.ownerUserId = await addUser(`member-${randomUUID()}`, 'member');

    const response = await post(startRoute, startBody());

    expectClearRefusal(await refusalOf(response), MEMBER_MESSAGE);
    expect(await sessionCount()).toBe(0);
    expectNothingSpent();
  });

  it('refuses More Like This before any seed is read', async () => {
    const response = await post(moreLikeThisRoute, {
      seedTrackIds: [randomUUID()],
      clientId: 'music-key-test',
    });

    expectClearRefusal(await refusalOf(response), ADMIN_MESSAGE);
    expect(await sessionCount()).toBe(0);
    expectNothingSpent();
  });

  it('refuses a Surprise Me proposal and stores no suggestion', async () => {
    const response = await post(proposeRoute, { replaces: null });

    expectClearRefusal(await refusalOf(response), ADMIN_MESSAGE);
    expect(await getPendingProposal(db(), holder.ownerUserId!)).toBeNull();
    expectNothingSpent();
  });

  it('refuses a Surprise Me start and keeps the suggestion pending', async () => {
    process.env.SUNO_API_KEY = 'suno-env-key-for-the-proposal';
    const proposed = proposeSurpriseResponseSchema.parse(
      await (await post(proposeRoute, { replaces: null })).json(),
    );
    if (!proposed.ok) throw new Error(`proposal refused: ${proposed.error.code}`);
    const proposalId = proposed.data.proposal.id;
    delete process.env.SUNO_API_KEY;
    limiterChecks.mockClear();

    const response = await post(startSurpriseRoute, { proposalId });

    expectClearRefusal(await refusalOf(response), ADMIN_MESSAGE);
    expect((await getPendingProposal(db(), holder.ownerUserId!))?.id).toBe(proposalId);
    expect(await sessionCount()).toBe(0);
    expect(limiterChecks).not.toHaveBeenCalled();
  });

  it('still surfaces a failure that is not the music configuration as an error', async () => {
    holder.musicOverride = async () => {
      throw new Error('connection terminated unexpectedly');
    };

    await expect(post(startRoute, startBody())).rejects.toThrow(/connection terminated/);
    expect(await sessionCount()).toBe(0);
  });
});

describe.skipIf(skip)('the Assistant asked for a new Session without a usable music key', () => {
  function ask(...calls: { name: string; input: unknown }[]): Promise<ToolCallsTurn> {
    return askWithToolCalls(
      assistantRoute,
      (llm) => {
        holder.llm = llm;
      },
      calls,
    );
  }

  const cards = ({ events }: ToolCallsTurn): AssistantCard[] =>
    events.flatMap((event) =>
      event.type === 'action' && event.action.status === 'proposed' ? [event.action.card] : [],
    );

  it('shows no Session card and tells the model the refusal', async () => {
    const turn = await ask({
      name: 'proposeSession',
      input: { prompt: 'calm piano for reading', targetDurationMinutes: 30 },
    });

    expect(cards(turn)).toEqual([]);
    expect(turn.results[0]).toContain(ADMIN_MESSAGE);
    expect(turn.results[0]).toMatch(/no card was shown/i);
    expect(turn.events.at(-1)).toEqual({ type: 'done' });
    expect(await sessionCount()).toBe(0);
  });

  it('shows no More Like This card and tells the model the refusal', async () => {
    const seedSessionId = await createSession(db(), {
      ownerUserId: holder.ownerUserId!,
      status: 'stopped',
    });
    const generationRequestId = await createGenerationRequest(db(), {
      ownerUserId: holder.ownerUserId!,
      activitySessionId: seedSessionId,
    });
    const providerJobId = await createProviderJob(db(), { generationRequestId });
    const trackId = await createTrack(db(), {
      ownerUserId: holder.ownerUserId!,
      generationRequestId,
      providerJobId,
    });

    const turn = await ask({ name: 'proposeMoreLikeThis', input: { trackIds: [trackId] } });

    expect(cards(turn)).toEqual([]);
    expect(turn.results[0]).toContain(ADMIN_MESSAGE);
    expect(turn.results[0]).toMatch(/no card was shown/i);
    expect(await sessionCount()).toBe(1);
  });
});
