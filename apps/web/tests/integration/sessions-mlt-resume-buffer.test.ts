import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from 'graphile-worker';
import { moreLikeThisResponseSchema, resumeSessionResponseSchema } from '@liedmotif/shared';
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

// More Like This and Resume must kick the session's `ensure-session-buffer` job
// in the same request, exactly like Start Session:
// without it the first generation silently waits for the worker's once-per-minute
// sweep. Same job key as the sweep, so the enqueues dedupe. Runs against the REAL
// `graphile_worker` schema, so what is asserted is the actual queued job.

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
// Hermetic providers: no text LLM (seeded naming falls back to the deterministic
// composition) and the mock music provider — never spend money or touch the network.
vi.mock('@/lib/providers', async () => {
  const { mockMusicProvider } = await import('@liedmotif/providers');
  const music = mockMusicProvider();
  return {
    getLlmProvider: async () => null,
    getMusicProvider: () => music,
    getStorageProvider: () => ({ stat: async () => null }),
  };
});

const { POST: moreLikeThis } = await import('@/app/api/sessions/more-like-this/route');
const { POST: resume } = await import('@/app/api/sessions/resume/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

async function bufferJobKeys(): Promise<string[]> {
  const { rows } = await testDb.pool.query<{ key: string | null }>(
    `select j.key
       from graphile_worker._private_jobs j
       join graphile_worker._private_tasks t on t.id = j.task_id
      where t.identifier = 'ensure-session-buffer'`,
  );
  return rows.map((row) => row.key ?? '');
}

function jsonPost(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('sessions-mlt-resume-buffer-test');
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

describe.skipIf(skip)('More Like This / Resume — immediate buffer fill', () => {
  it('More Like This enqueues the new session buffer-fill job in the creation request', async () => {
    const ownerUserId = holder.ownerUserId!;
    const seedSessionId = await createSession(testDb.db, {
      ownerUserId,
      styleSnapshot: { genreTags: ['lofi'], energy: 'low', vocalMode: 'instrumental' },
    });
    const generationRequestId = await createGenerationRequest(testDb.db, {
      ownerUserId,
      activitySessionId: seedSessionId,
    });
    const providerJobId = await createProviderJob(testDb.db, { generationRequestId });
    const seedTrackId = await createTrack(testDb.db, {
      ownerUserId,
      generationRequestId,
      providerJobId,
    });

    const res = await moreLikeThis(
      jsonPost('http://localhost/api/sessions/more-like-this', {
        seedTrackIds: [seedTrackId],
        clientId: 'mlt-buffer-test-client',
      }),
    );
    const parsed = moreLikeThisResponseSchema.parse(await res.json());
    if (!parsed.ok) throw new Error(`expected an ok response, got ${parsed.error.code}`);

    expect(await bufferJobKeys()).toEqual([`buffer:${parsed.data.session.id}`]);
  });

  it('Resume enqueues the resumed session buffer-fill job in the same request', async () => {
    const ownerUserId = holder.ownerUserId!;
    const sessionId = await createSession(testDb.db, { ownerUserId, status: 'stopped' });

    const res = await resume(
      jsonPost('http://localhost/api/sessions/resume', {
        sessionId,
        clientId: 'resume-buffer-test',
      }),
    );
    const parsed = resumeSessionResponseSchema.parse(await res.json());
    if (!parsed.ok) throw new Error(`expected an ok response, got ${parsed.error.code}`);

    expect(await bufferJobKeys()).toEqual([`buffer:${sessionId}`]);
  });
});
