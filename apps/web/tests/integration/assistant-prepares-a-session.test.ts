// What happens when the Assistant's model asks for a new Session: the reply
// stream carries a card, and nothing is created or bought. The route, the tool
// and the app's own budget check run against a real database; a scripted model
// stands in for the text LLM.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  updateCoverArtSettings,
  updateGenerationSettings,
  updateUsageLimits,
  user,
  userProfiles,
} from '@liedmotif/db';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import type { AssistantCard } from '@liedmotif/shared';
import { askWithToolCalls, type ToolCallsTurn } from '../helpers/assistant-tool-turn';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionUserId: null as string | null,
  llm: null as unknown,
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/auth', () => ({
  getAuth: () => ({
    api: {
      getSession: async () =>
        holder.sessionUserId
          ? { session: { id: 'live' }, user: { id: holder.sessionUserId } }
          : null,
    },
  }),
}));
vi.mock('@/lib/providers/providers', () => ({
  getLlmProvider: async () => holder.llm,
  // Two Tracks per call: budgets are counted in calls and gated in Tracks.
  getTypicalTracksPerMusicRequest: () => 2,
  getMusicProvider: async () => ({ getCapabilities: () => ({ typicalTracksPerRequest: 2 }) }),
}));

const { POST } = await import('@/app/api/assistant/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

/**
 * The Admin under an id of their own. The route's burst limit counts per user
 * id for as long as the process lives, so no two tests share one.
 */
let admins = 0;
async function createAdmin(): Promise<string> {
  admins += 1;
  const id = `admin-${admins}`;
  await testDb.db.insert(user).values({ id, name: id, email: `${id}@example.test` });
  await testDb.db.insert(userProfiles).values({ userId: id, role: 'admin' });
  return id;
}

/** A daily ceiling of `dailyCalls` music-model calls, and the Tracks a new Session needs left. */
async function setDailyCeiling(dailyCalls: number, minHeadroomTracks: number): Promise<void> {
  await updateUsageLimits(testDb.db, {
    trackCeilingEnabled: true,
    dailyGenerationTasks: dailyCalls,
    monthlyGenerationTasks: 400,
    minHeadroomTracksToStartSession: minHeadroomTracks,
    resetTimezone: 'UTC',
  });
}

/** `count` music-model calls `ownerUserId` has spent today. */
async function spendCalls(ownerUserId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const generationRequestId = await createGenerationRequest(testDb.db, { ownerUserId });
    await createProviderJob(testDb.db, { generationRequestId });
  }
}

/** `userId` sends one message; the model calls `proposeSession` once per input, all at once. */
function propose(userId: string, ...inputs: unknown[]): Promise<ToolCallsTurn> {
  holder.sessionUserId = userId;
  return askWithToolCalls(
    POST,
    (llm) => {
      holder.llm = llm;
    },
    inputs.map((input) => ({ name: 'proposeSession', input })),
  );
}

/** The cards a reply stream carried, in order. */
const cards = ({ events }: ToolCallsTurn): AssistantCard[] =>
  events.flatMap((event) =>
    event.type === 'action' && event.action.status === 'proposed' ? [event.action.card] : [],
  );

/** How many rows `table` holds. */
async function rowsIn(table: 'activity_sessions' | 'generation_requests'): Promise<number> {
  const { rows } = await testDb.pool.query<{ n: number }>(
    `select count(*)::int as n from ${table}`,
  );
  return rows[0]!.n;
}

/** The shipped cover-art settings, which Home's form starts a new Session with.
 *  Their style, Auto, is the one a request leaves out. */
const HOME_COVER = { useStandardCover: false } as const;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('assistant-prepares-a-session-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, [
    ...GENERATION_FIXTURE_TABLES,
    'user_settings',
    'app_settings',
  ]);
  holder.sessionUserId = null;
});

describe.skipIf(skip)('the Assistant asked to start a Session', () => {
  it('sends a card with the values the click will send, and creates nothing', async () => {
    const asker = await createAdmin();

    const turn = await propose(asker, {
      prompt: '  calm piano for reading ',
      targetDurationMinutes: 45,
    });

    expect(cards(turn)).toEqual([
      {
        kind: 'session',
        prompt: 'calm piano for reading',
        vocal: 'instrumental',
        targetDurationMinutes: 45,
        ...HOME_COVER,
      },
    ]);
    expect(turn.results[0]).toMatch(/^Prepared: /);
    expect(turn.results[0]).toMatch(/nothing (has|is) started/i);
    expect(turn.events.at(-1)).toEqual({ type: 'done' });
    expect(await rowsIn('activity_sessions')).toBe(0);
    expect(await rowsIn('generation_requests')).toBe(0);
  });

  it('carries the cover choices Home’s form starts with: the user’s Default cover style and Standard covers', async () => {
    const asker = await createAdmin();
    await updateCoverArtSettings(testDb.db, asker, {
      defaultStyle: 'manga',
      useStandardCoverArt: true,
    });
    const card = { prompt: 'calm piano', targetDurationMinutes: 30 };

    expect(cards(await propose(asker, card))).toMatchObject([
      { coverStyle: 'manga', useStandardCover: true },
    ]);

    // Auto is the start route's own default, so Home sends no style for it.
    await updateCoverArtSettings(testDb.db, asker, {
      defaultStyle: 'auto',
      useStandardCoverArt: false,
    });
    const [auto] = cards(await propose(asker, card));
    expect(auto).toMatchObject({ useStandardCover: false });
    expect(auto).not.toHaveProperty('coverStyle');
  });

  it('carries the shipped Default Session duration when the user named no length, and never asks how long', async () => {
    const asker = await createAdmin();

    const turn = await propose(asker, { prompt: 'calm piano for reading' });

    expect(cards(turn)).toEqual([
      {
        kind: 'session',
        prompt: 'calm piano for reading',
        vocal: 'instrumental',
        targetDurationMinutes: 30,
        ...HOME_COVER,
      },
    ]);
    expect(turn.results[0]).toMatch(/^Prepared: .*30 minutes/);
    expect(turn.results[0]).not.toMatch(/how long/i);
  });

  it('carries the user’s own Default Session duration when the user named no length', async () => {
    const asker = await createAdmin();
    await updateGenerationSettings(testDb.db, {
      ownerUserId: asker,
      patch: { defaultSessionDurationMinutes: 120 },
    });

    expect(cards(await propose(asker, { prompt: 'calm piano' }))).toMatchObject([
      { kind: 'session', targetDurationMinutes: 120 },
    ]);

    await updateGenerationSettings(testDb.db, {
      ownerUserId: asker,
      patch: { defaultSessionDurationMinutes: null },
    });

    expect(cards(await propose(asker, { prompt: 'calm piano' }))).toMatchObject([
      { kind: 'session', targetDurationMinutes: null },
    ]);
  });

  it('carries the length the user named over their Default Session duration', async () => {
    const asker = await createAdmin();
    await updateGenerationSettings(testDb.db, {
      ownerUserId: asker,
      patch: { defaultSessionDurationMinutes: 5 },
    });

    expect(
      cards(await propose(asker, { prompt: 'calm piano', targetDurationMinutes: 45 })),
    ).toMatchObject([{ kind: 'session', targetDurationMinutes: 45 }]);
  });

  it('prepares vocals only when the model says the user asked for them', async () => {
    const asker = await createAdmin();

    const turn = await propose(asker, {
      prompt: 'a sea shanty about deploys',
      vocal: true,
      targetDurationMinutes: 30,
    });

    expect(cards(turn)).toEqual([
      {
        kind: 'session',
        prompt: 'a sea shanty about deploys',
        vocal: 'vocal',
        targetDurationMinutes: 30,
        ...HOME_COVER,
      },
    ]);
  });

  it('prepares a Session with no limit only when the model says the user asked for that', async () => {
    const asker = await createAdmin();

    const turn = await propose(asker, { prompt: 'calm piano for reading', noLimit: true });

    expect(cards(turn)).toEqual([
      {
        kind: 'session',
        prompt: 'calm piano for reading',
        vocal: 'instrumental',
        targetDurationMinutes: null,
        ...HOME_COVER,
      },
    ]);
    expect(turn.results[0]).toMatch(/^Prepared: .*with no limit/);
  });

  it('prepares a Session with no limit whatever the user’s Default Session duration', async () => {
    const asker = await createAdmin();
    await updateGenerationSettings(testDb.db, {
      ownerUserId: asker,
      patch: { defaultSessionDurationMinutes: 5 },
    });

    const turn = await propose(asker, { prompt: 'calm piano for reading', noLimit: true });

    expect(cards(turn)).toEqual([
      {
        kind: 'session',
        prompt: 'calm piano for reading',
        vocal: 'instrumental',
        targetDurationMinutes: null,
        ...HOME_COVER,
      },
    ]);
  });

  it('gives the model the app’s refusal and sends no card when the budget is used up', async () => {
    const asker = await createAdmin();
    await setDailyCeiling(2, 4);
    await spendCalls(asker, 2);

    const turn = await propose(asker, { prompt: 'calm piano for reading' });

    expect(cards(turn)).toEqual([]);
    expect(turn.results[0]).toContain('A new session needs 4 tracks; you have none left today.');
    expect(turn.results[0]).toMatch(/no card was shown/i);
    expect(await rowsIn('activity_sessions')).toBe(0);
  });

  it('gives the model the pause refusal, not the budget one, and sends no card while new music is paused', async () => {
    const asker = await createAdmin();
    await setDailyCeiling(2, 4);
    await spendCalls(asker, 2);
    await updateUsageLimits(testDb.db, { manualGenerationOnly: true });

    const turn = await propose(asker, { prompt: 'calm piano for reading' });

    expect(cards(turn)).toEqual([]);
    expect(turn.results[0]).toContain('New Music is paused in Settings › Generation.');
    expect(turn.results[0]).not.toContain('A new session needs');
    expect(turn.results[0]).toMatch(/no card was shown/i);
    expect(await rowsIn('activity_sessions')).toBe(0);
  });

  it('refuses a second card in one turn', async () => {
    const asker = await createAdmin();

    const turn = await propose(
      asker,
      { prompt: 'calm piano', targetDurationMinutes: 30 },
      { prompt: 'loud guitars', targetDurationMinutes: 30 },
    );

    expect(cards(turn)).toEqual([
      {
        kind: 'session',
        prompt: 'calm piano',
        vocal: 'instrumental',
        targetDurationMinutes: 30,
        ...HOME_COVER,
      },
    ]);
    expect(turn.results[1]).toMatch(/only one card can be prepared.*no second card/i);
  });

  it.each([
    ['no words to start from', { prompt: '   ' }],
    ['a duration the app does not take', { prompt: 'calm piano', targetDurationMinutes: 601 }],
    ['a duration that is not whole minutes', { prompt: 'calm piano', targetDurationMinutes: 7.5 }],
  ])('tells the model about %s and sends no card', async (_what, input) => {
    const asker = await createAdmin();

    const turn = await propose(asker, input);

    expect(cards(turn)).toEqual([]);
    expect(turn.results[0]).toMatch(/no card was shown/i);
  });
});
