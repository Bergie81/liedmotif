import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSISTANT_STANDING_HEADER,
  assistantStandingSchema,
  errorResponseSchema,
  type AssistantStanding,
} from '@liedmotif/shared';
import {
  updateAssistantAccess,
  updateMemberAssistantAccess,
  updateUsageLimits,
  user,
  userProfiles,
} from '@liedmotif/db';
import {
  connectTestDb,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { createOpenRouterLlmProvider, type LlmProvider } from '@liedmotif/providers';
import { scriptedLanguageModel, type ScriptedModelStep } from '@liedmotif/providers/testing';
import { loadDocs } from '@/lib/assistant/docs';

// Who may ask the Assistant, and how often: the access switch and the daily
// message allowance, as the endpoint enforces them against a real database.

const holder = vi.hoisted(() => ({
  db: null as unknown,
  userId: null as string | null,
  llm: null as unknown,
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => null,
  getAppSession: async () => (holder.userId ? { user: { id: holder.userId } } : null),
}));
vi.mock('@/lib/providers', () => ({ getLlmProvider: async () => holder.llm }));

const { POST } = await import('@/app/api/assistant/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;
/** Every user gets an id of its own: the burst limit is counted per user, for the whole run. */
let users = 0;

async function createUser(role: 'admin' | 'member'): Promise<string> {
  users += 1;
  const id = `${role}-${users}-${Date.now()}`;
  await testDb.db.insert(user).values({ id, name: id, email: `${id}@example.test` });
  await testDb.db.insert(userProfiles).values({ userId: id, role });
  return id;
}

/** Configure a text LLM whose model follows the script; returns the model to inspect. */
function scriptModel(steps: ScriptedModelStep[]) {
  const model = scriptedLanguageModel(steps);
  holder.llm = createOpenRouterLlmProvider({
    apiKey: 'sk-or-test-key',
    model: 'test-model',
    languageModel: model,
  }) satisfies LlmProvider;
  return model;
}

/** One message from the signed-in user. */
function ask(): Promise<Response> {
  return POST(
    new Request('http://localhost/api/assistant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'How do I invite someone?' }] }),
    }),
  );
}

/** Sends `count` messages one after the other; the status of each. */
async function askTimes(count: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const response = await ask();
    statuses.push(response.status);
    await response.text();
  }
  return statuses;
}

/** Where the response says the user stands. */
function standingOf(response: Response): AssistantStanding {
  return assistantStandingSchema.parse(
    JSON.parse(response.headers.get(ASSISTANT_STANDING_HEADER) ?? 'null'),
  );
}

async function errorCodeOf(response: Response): Promise<string> {
  return errorResponseSchema.parse(await response.json()).error.code;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('assistant-daily-allowance-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, ['user', 'user_settings', 'app_settings', 'assistant_usage']);
  holder.llm = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.skipIf(skip)('the Assistant daily allowance', () => {
  it('gives a Member without an allowance of their own the instance default', async () => {
    const model = scriptModel([{ text: ['Sure.'] }]);
    holder.userId = await createUser('member');

    const first = await ask();

    expect(first.status).toBe(200);
    expect(standingOf(first)).toMatchObject({
      enabled: true,
      allowance: { dailyMessages: 30, remaining: 29 },
    });
    await first.text();

    // The default moves, and the Member with it: one message is already spent.
    await updateAssistantAccess(testDb.db, { dailyMessages: 2 });
    expect(await askTimes(1)).toEqual([200]);
    const refused = await ask();

    expect(refused.status).toBe(429);
    expect(standingOf(refused)).toMatchObject({ allowance: { dailyMessages: 2, remaining: 0 } });
    expect(await errorCodeOf(refused)).toBe('assistant_allowance_used_up');
    expect(model.doStreamCalls).toHaveLength(2);
  });

  it('holds a Member to their own allowance, whatever the default says', async () => {
    scriptModel([{ text: ['Sure.'] }]);
    holder.userId = await createUser('member');
    await updateAssistantAccess(testDb.db, { dailyMessages: 1 });
    await updateMemberAssistantAccess(testDb.db, {
      ownerUserId: holder.userId,
      patch: { dailyMessages: 3 },
    });

    expect(await askTimes(4)).toEqual([200, 200, 200, 429]);

    // Another Member, given nothing of their own, is still on the default.
    holder.userId = await createUser('member');
    expect(await askTimes(2)).toEqual([200, 429]);
  });

  it('puts a Member back on the default once their own allowance is cleared', async () => {
    scriptModel([{ text: ['Sure.'] }]);
    holder.userId = await createUser('member');
    await updateAssistantAccess(testDb.db, { dailyMessages: 2 });
    await updateMemberAssistantAccess(testDb.db, {
      ownerUserId: holder.userId,
      patch: { enabled: true, dailyMessages: 1 },
    });
    expect(await askTimes(2)).toEqual([200, 429]);

    await updateMemberAssistantAccess(testDb.db, {
      ownerUserId: holder.userId,
      patch: { dailyMessages: null },
    });

    expect(await askTimes(2)).toEqual([200, 429]);
  });

  it('starts a new count at midnight in the Instance timezone, not in UTC', async () => {
    scriptModel([{ text: ['Sure.'] }]);
    holder.userId = await createUser('member');
    await updateUsageLimits(testDb.db, { resetTimezone: 'Asia/Tokyo' });
    await updateAssistantAccess(testDb.db, { dailyMessages: 1 });
    vi.useFakeTimers({ toFake: ['Date'] });

    // 23:50 on 1 March in Tokyo.
    vi.setSystemTime(new Date('2026-03-01T14:50:00.000Z'));
    const last = await ask();
    expect(standingOf(last).allowance).toEqual({
      dailyMessages: 1,
      remaining: 0,
      resetsAt: '2026-03-01T15:00:00.000Z',
    });
    await last.text();
    expect(await askTimes(1)).toEqual([429]);

    // 00:10 on 2 March in Tokyo, while UTC is still on 1 March.
    vi.setSystemTime(new Date('2026-03-01T15:10:00.000Z'));
    expect(await askTimes(2)).toEqual([200, 429]);

    // UTC passes its own midnight; in Tokyo it is still 2 March.
    vi.setSystemTime(new Date('2026-03-02T00:10:00.000Z'));
    expect(await askTimes(1)).toEqual([429]);
  });

  it('never holds the Admin to a daily allowance, only to the burst limit', async () => {
    scriptModel([{ text: ['Sure.'] }]);
    holder.userId = await createUser('admin');
    await updateAssistantAccess(testDb.db, { enabled: false, dailyMessages: 1 });

    const first = await ask();
    expect(first.status).toBe(200);
    expect(standingOf(first)).toEqual({ enabled: true, allowance: null });
    await first.text();
    expect(await askTimes(19)).toEqual(Array<number>(19).fill(200));

    const burst = await ask();
    expect(burst.status).toBe(429);
    expect(await errorCodeOf(burst)).toBe('rate_limited');
  });

  it('lets messages sent in parallel through only up to the allowance', async () => {
    const model = scriptModel([{ text: ['Sure.'] }]);
    holder.userId = await createUser('member');
    await updateAssistantAccess(testDb.db, { dailyMessages: 3 });
    // Both pooled connections must be open, or the messages queue behind a
    // handshake and never overlap.
    await Promise.all([testDb.pool.query('SELECT 1'), testDb.pool.query('SELECT 1')]);

    const responses = await Promise.all(Array.from({ length: 8 }, () => ask()));

    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 200, 200, 429, 429, 429, 429, 429,
    ]);
    const refused = responses.filter((response) => response.status === 429);
    for (const response of refused) {
      expect(await errorCodeOf(response)).toBe('assistant_allowance_used_up');
    }
    expect(model.doStreamCalls).toHaveLength(3);

    // The five turned away took nothing from the burst budget either: of its
    // 20 messages, 17 are still open.
    await updateAssistantAccess(testDb.db, { dailyMessages: 30 });
    expect(await askTimes(17)).toEqual(Array<number>(17).fill(200));
    expect(await errorCodeOf(await ask())).toBe('rate_limited');
  });

  it('refuses a Member whose access is off before any text-LLM call', async () => {
    const model = scriptModel([{ text: ['Sure.'] }]);
    holder.userId = await createUser('member');
    await updateMemberAssistantAccess(testDb.db, {
      ownerUserId: holder.userId,
      patch: { enabled: false },
    });

    const refused = await ask();

    expect(refused.status).toBe(403);
    expect(standingOf(refused).enabled).toBe(false);
    const { error } = errorResponseSchema.parse(await refused.json());
    expect(error).toMatchObject({ code: 'assistant_access_off', retryable: false });
    // More refusals than the burst budget holds: none of them spends any of it.
    expect(await askTimes(24)).toEqual(Array<number>(24).fill(403));
    expect(model.doStreamCalls).toHaveLength(0);

    await updateMemberAssistantAccess(testDb.db, {
      ownerUserId: holder.userId,
      patch: { enabled: null },
    });
    expect(await askTimes(1)).toEqual([200]);
  });

  it('switches the Assistant off for every Member who has no setting of their own', async () => {
    scriptModel([{ text: ['Sure.'] }]);
    await updateAssistantAccess(testDb.db, { enabled: false });

    holder.userId = await createUser('member');
    expect(await askTimes(1)).toEqual([403]);

    holder.userId = await createUser('member');
    await updateMemberAssistantAccess(testDb.db, {
      ownerUserId: holder.userId,
      patch: { enabled: true },
    });
    expect(await askTimes(1)).toEqual([200]);
  });

  it('charges a refused message nothing', async () => {
    const model = scriptModel([{ text: ['Sure.'] }]);
    holder.userId = await createUser('member');
    await updateAssistantAccess(testDb.db, { dailyMessages: 1 });
    expect(await askTimes(1)).toEqual([200]);

    // More refusals than the burst budget holds.
    expect(await askTimes(25)).toEqual(Array<number>(25).fill(429));
    expect(model.doStreamCalls).toHaveLength(1);

    await updateAssistantAccess(testDb.db, { dailyMessages: 3 });
    const next = await ask();
    expect(next.status).toBe(200);
    expect(standingOf(next).allowance).toMatchObject({ dailyMessages: 3, remaining: 1 });
  });

  it('names the allowance, not the burst limit, when both have run out', async () => {
    scriptModel([{ text: ['Sure.'] }]);
    holder.userId = await createUser('member');
    await updateAssistantAccess(testDb.db, { dailyMessages: 20 });
    expect(await askTimes(20)).toEqual(Array<number>(20).fill(200));

    // Waiting out the burst window would not help; the answer must say so.
    expect(await errorCodeOf(await ask())).toBe('assistant_allowance_used_up');

    await updateMemberAssistantAccess(testDb.db, {
      ownerUserId: holder.userId,
      patch: { enabled: false },
    });
    expect(await errorCodeOf(await ask())).toBe('assistant_access_off');
  });

  it('counts one message however many tool steps the answer takes', async () => {
    const page = loadDocs()[0]!.slug;
    const read = { toolCalls: [{ name: 'readDocs', input: { page, section: 'intro' } }] };
    const model = scriptModel([read, read, { text: ['Here it is.'] }]);
    holder.userId = await createUser('member');

    const answered = await ask();
    await answered.text();

    expect(model.doStreamCalls).toHaveLength(3);
    expect(standingOf(answered).allowance?.remaining).toBe(29);
    expect(standingOf(await ask()).allowance?.remaining).toBe(28);
  });

  it('counts a message the text LLM then fails to answer', async () => {
    scriptModel([{ fail: new Error('provider down') }]);
    holder.userId = await createUser('member');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const failed = await ask();

    expect(failed.status).toBe(502);
    expect(standingOf(failed).allowance?.remaining).toBe(29);
    expect(standingOf(await ask()).allowance?.remaining).toBe(28);
  });

  it('keeps a count per user and day, and nothing of the message', async () => {
    scriptModel([{ text: ['Sure.'] }]);
    holder.userId = await createUser('member');
    await updateUsageLimits(testDb.db, { resetTimezone: 'UTC' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));

    await askTimes(2);

    const { rows } = await testDb.pool.query('SELECT * FROM assistant_usage');
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(['day', 'messages', 'user_id']);
    expect(rows[0]).toMatchObject({ user_id: holder.userId, messages: 2 });
  });
});
