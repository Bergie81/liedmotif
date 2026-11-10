import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAssistantTone } from '@liedmotif/db';
import { ASSISTANT_TONE_MAX_LENGTH } from '@liedmotif/shared';
import {
  connectTestDb,
  createUser,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// Saving the tone a user gives the Assistant: no tone before one is saved, the
// round trip, the length limit, and that one user's tone is theirs alone. The
// saved tone is read the way the Assistant and its settings page read it.

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));

const { POST } = await import('@/app/api/settings/assistant-tone/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/settings/assistant-tone', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

const savedTone = async (userId: string) => (await getAssistantTone(testDb.db, userId)).tone;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('settings-assistant-tone-route-test');
  holder.db = testDb.db;
});
afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});
beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, ['user_settings', 'user']);
  holder.ownerUserId = null;
});

describe.skipIf(skip)('POST /api/settings/assistant-tone', () => {
  it('leaves a user without a tone until they save one', async () => {
    const userId = await createUser(testDb.db);
    expect(await savedTone(userId)).toBe('');
  });

  it('saves a tone and answers with it, without the space around it', async () => {
    const userId = (holder.ownerUserId = await createUser(testDb.db));
    const saved = await post({ tone: '  Talk like a ship captain.\n' });
    expect(await saved.json()).toEqual({ ok: true, data: { tone: 'Talk like a ship captain.' } });
    expect(await savedTone(userId)).toBe('Talk like a ship captain.');
  });

  it.each([
    ['an empty tone', ''],
    ['a tone of nothing but space', ' \n  '],
  ])('takes %s as going back to the default voice', async (_name, tone) => {
    const userId = (holder.ownerUserId = await createUser(testDb.db));
    await post({ tone: 'Talk like a ship captain.' });
    expect((await post({ tone })).status).toBe(200);
    expect(await savedTone(userId)).toBe('');
  });

  it("keeps each user's tone their own", async () => {
    const first = (holder.ownerUserId = await createUser(testDb.db));
    await post({ tone: 'Talk like a ship captain.' });
    const second = (holder.ownerUserId = await createUser(testDb.db));
    expect(await savedTone(second)).toBe('');
    await post({ tone: 'Calm.' });
    expect(await savedTone(first)).toBe('Talk like a ship captain.');
    expect(await savedTone(second)).toBe('Calm.');
  });

  it('takes a tone of the longest length, space around it not counted, and refuses one character more', async () => {
    holder.ownerUserId = await createUser(testDb.db);
    const longest = 'a'.repeat(ASSISTANT_TONE_MAX_LENGTH);
    expect((await post({ tone: `  ${longest}\n` })).status).toBe(200);
    expect((await post({ tone: `${longest}a` })).status).toBe(400);
  });

  it.each([
    ['no tone at all', {}],
    ['a tone that is not text', { tone: 7 }],
    ['an unknown key', { tone: 'Calm.', name: 'Rudi' }],
  ])('refuses %s', async (_name, body) => {
    holder.ownerUserId = await createUser(testDb.db);
    expect((await post(body)).status).toBe(400);
  });

  it('refuses a caller who is not signed in', async () => {
    expect((await post({ tone: 'Calm.' })).status).toBe(401);
  });
});
