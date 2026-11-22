import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from 'graphile-worker';
import { startSessionResponseSchema } from '@liedmotif/shared';
import { mockLlmProvider, ProviderError, type LlmProvider } from '@liedmotif/providers';
import { updateGenerationSettings, updateUsageLimits } from '@liedmotif/db';
import {
  connectTestDb,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// Start Session's immediate buffer fill: creating a
// Session enqueues its `ensure-session-buffer` job in the same request — through
// the worker's SQL enqueue function, so the web app gets no worker runtime and
// all generation stays worker-owned. The sweep remains the safety net (same job
// key → the two enqueues dedupe), and a headroom-blocked request creates no
// session row AND no job. Runs against the REAL `graphile_worker` schema (the
// worker migrator's), so what is asserted is the actual queued job.

const holder = vi.hoisted(() => ({
  db: null as unknown,
  ownerUserId: null as string | null,
  llm: null as LlmProvider | null,
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
// Hermetic providers: no text LLM unless a test stubs one (controls naming falls
// back to the deterministic composition) and the mock music provider — a real `.env` must
// never let this suite spend money or touch the network.
vi.mock('@/lib/providers/providers', async () => {
  const { mockMusicProvider } = await import('@liedmotif/providers');
  const music = mockMusicProvider();
  return {
    getLlmProvider: async () => holder.llm,
    getMusicProvider: () => music,
  };
});

const { POST } = await import('@/app/api/sessions/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

async function startControlsSession() {
  const res = await POST(
    new Request('http://localhost/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: { mode: 'controls', controls: { mood: 'calm', energy: 'low' } },
        clientId: 'start-buffer-test-client',
      }),
    }),
  );
  return startSessionResponseSchema.parse(await res.json());
}

async function bufferJobs(): Promise<Array<{ payload: unknown; runAt: Date; key: string | null }>> {
  // The `graphile_worker.jobs` view omits `payload` (0.17), so read the
  // underlying tables the enqueue function writes.
  const { rows } = await testDb.pool.query<{
    payload: unknown;
    run_at: Date;
    key: string | null;
  }>(`select j.payload, j.run_at, j.key
      from graphile_worker._private_jobs j
      join graphile_worker._private_tasks t on t.id = j.task_id
      where t.identifier = 'ensure-session-buffer'`);
  return rows.map((row) => ({ payload: row.payload, runAt: row.run_at, key: row.key }));
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('sessions-start-buffer-test');
  holder.db = testDb.db;
  // Install the worker's job-queue schema exactly as the worker migrator does
  // (idempotent), so the route's SQL enqueue has its real target.
  await runMigrations({ connectionString: TEST_DATABASE_URL });
}, 60_000);
afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});
beforeEach(async () => {
  if (skip) return;
  // `app_settings` holds the stored usage limits — reset them so one test's
  // blocked-headroom configuration never leaks into the next.
  await truncateTables(testDb.pool, [...GENERATION_FIXTURE_TABLES, 'app_settings']);
  await testDb.pool.query('delete from graphile_worker._private_jobs');
  holder.ownerUserId = await createUser(testDb.db);
  holder.llm = null;
});

describe.skipIf(skip)('POST /api/sessions — immediate buffer fill', () => {
  it('enqueues the session buffer-fill job in the creation request, due immediately', async () => {
    const before = Date.now();
    const parsed = await startControlsSession();
    if (!parsed.ok) throw new Error('expected an ok start-session response');

    const jobs = await bufferJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ sessionId: parsed.data.session.id });
    // Due now — the time to the provider submit no longer depends on the sweep cadence.
    expect(jobs[0]!.runAt.getTime()).toBeLessThanOrEqual(before + 60_000);
    // The sweep's job key, so its later enqueue dedupes instead of double-queuing.
    expect(jobs[0]!.key).toBe(`buffer:${parsed.data.session.id}`);
  });

  it('starts every new Session on Keep Going, whatever its length', async () => {
    const ownerUserId = holder.ownerUserId!;
    for (const defaultSessionDurationMinutes of [30, 5, null] as const) {
      await updateGenerationSettings(testDb.db, {
        ownerUserId,
        patch: { defaultSessionDurationMinutes },
      });
      const started = await startControlsSession();
      if (!started.ok) throw new Error('expected an ok start-session response');
      expect(started.data.session.sessionMode).toBe('keep_going');
    }
  });

  it('a headroom-blocked request creates no session row and enqueues nothing', async () => {
    await updateUsageLimits(testDb.db, {
      dailyGenerationTasks: 2,
      monthlyGenerationTasks: 400,
      minHeadroomTracksToStartSession: 100,
      resetTimezone: 'UTC',
    });

    const parsed = await startControlsSession();
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe('session_headroom_blocked');

    const { rows } = await testDb.pool.query('select id from activity_sessions');
    expect(rows).toHaveLength(0);
    expect(await bufferJobs()).toHaveLength(0);
  });
});

async function startPromptDuration(
  prompt: string,
  length: { targetDurationMinutes?: number | null } = {},
) {
  const response = await POST(
    new Request('http://localhost/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: { mode: 'prompt', prompt },
        clientId: 'duration-cases',
        ...length,
      }),
    }),
  );
  return startSessionResponseSchema.parse(await response.json());
}

async function stubLlmDurationReply(requestedDurationMinutes: number | null | undefined) {
  const llm = mockLlmProvider();
  const expansion = await llm.expandSessionIntentWithMetadata('meditation');
  const expandSessionIntentWithMetadata = vi.fn().mockResolvedValue({
    ...expansion,
    requestedDurationMinutes,
  });
  holder.llm = { ...llm, expandSessionIntentWithMetadata };
  return expandSessionIntentWithMetadata;
}

describe.skipIf(skip)('POST /api/sessions — Auto duration', () => {
  it('persists an explicit duration extracted during the configured text LLM expansion', async () => {
    const expand = await stubLlmDurationReply(20);
    const result = await startPromptDuration('Zwanzig Minuten Meditation');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.session.targetDurationMinutes).toBe(20);
    expect(expand).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(skip)('POST /api/sessions — duration resolution', () => {
  it.each([
    ['doce minutos de piano', 12],
    ['eight hours of ambient', 480],
    ['one minute of bells', 1],
    ['ten hours of focus', 600],
  ])('preserves exact requested duration: %s', async (prompt, minutes) => {
    await stubLlmDurationReply(minutes);
    const result = await startPromptDuration(prompt);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.session.targetDurationMinutes).toBe(minutes);
  });

  it.each([20, 601, 0, 1.5])('explicit duration wins over extracted %s', async (extracted) => {
    await stubLlmDurationReply(extracted);
    const result = await startPromptDuration('music for a while', { targetDurationMinutes: 30 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.session.targetDurationMinutes).toBe(30);
  });

  it.each([0, -1, 601, 1.5])(
    'rejects unsupported extracted duration %s without creating a Session',
    async (minutes) => {
      await stubLlmDurationReply(minutes);
      const result = await startPromptDuration('music with a requested duration');
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'validation_error',
          message: 'Session duration must be a whole number from 1 to 600 minutes.',
        },
      });
      expect((await testDb.pool.query('select id from activity_sessions')).rows).toHaveLength(0);
      expect(await bufferJobs()).toHaveLength(0);
    },
  );

  it.each([null, undefined])(
    'takes the Default Session duration when the LLM returns no duration: %s',
    async (value) => {
      await stubLlmDurationReply(value);
      const result = await startPromptDuration('meditation with 80 BPM and 1990s warmth');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.session.targetDurationMinutes).toBe(30);
    },
  );

  it('a prompt duration beats the Default Session duration', async () => {
    await updateGenerationSettings(testDb.db, {
      ownerUserId: holder.ownerUserId!,
      patch: { defaultSessionDurationMinutes: 5 },
    });
    await stubLlmDurationReply(20);
    const result = await startPromptDuration('Zwanzig Minuten Meditation');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.session.targetDurationMinutes).toBe(20);
  });

  it('an explicit null is No limit, over a prompt duration and the default', async () => {
    const expand = await stubLlmDurationReply(20);
    const result = await startPromptDuration('Zwanzig Minuten Meditation', {
      targetDurationMinutes: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.session.targetDurationMinutes).toBeNull();
    expect(result.data.session.sessionMode).toBe('keep_going');
    expect(expand).toHaveBeenCalledTimes(1);
  });

  it('takes the Default Session duration without a text LLM, even for a prompt duration', async () => {
    const result = await startPromptDuration('Twenty minutes of meditation');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.session.targetDurationMinutes).toBe(30);
  });

  it("takes the user's own Default Session duration, No limit included", async () => {
    const ownerUserId = holder.ownerUserId!;
    await updateGenerationSettings(testDb.db, {
      ownerUserId,
      patch: { defaultSessionDurationMinutes: 120 },
    });
    const long = await startPromptDuration('quiet piano');
    expect(long.ok && long.data.session.targetDurationMinutes).toBe(120);

    await updateGenerationSettings(testDb.db, {
      ownerUserId,
      patch: { defaultSessionDurationMinutes: null },
    });
    const endless = await startPromptDuration('quiet piano');
    expect(endless.ok).toBe(true);
    if (endless.ok) expect(endless.data.session.targetDurationMinutes).toBeNull();
  });

  it('honors manual duration without a text LLM', async () => {
    const result = await startPromptDuration('Twenty minutes of meditation', {
      targetDurationMinutes: 45,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.session.targetDurationMinutes).toBe(45);
  });

  it('keeps a configured expansion failure retryable rather than creating an unlimited Session', async () => {
    holder.llm = {
      ...mockLlmProvider(),
      expandSessionIntentWithMetadata: vi
        .fn()
        .mockRejectedValue(new ProviderError('Unavailable', { retryable: true })),
    };
    const result = await startPromptDuration('Twenty minutes of meditation');
    expect(result).toMatchObject({ ok: false, error: { code: 'provider_error', retryable: true } });
    expect((await testDb.pool.query('select id from activity_sessions')).rows).toHaveLength(0);
  });
});
