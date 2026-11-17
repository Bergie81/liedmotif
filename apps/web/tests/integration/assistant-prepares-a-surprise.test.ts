// What happens when the Assistant's model asks for a Surprise Me: the app's own
// propose function prepares a suggestion, which stays pending as Home's would,
// and the reply stream carries a card for it. Nothing is started or bought.
// The route, the tool and the app's own gates run against a real database; a
// scripted model stands in for the text LLM's tool-calling, and the mock text
// LLM writes and expands the suggestion.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPendingProposal,
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
import { mockLlmProvider, type SurpriseRequestInput } from '@liedmotif/providers';
import type { AssistantCard } from '@liedmotif/shared';
import { createAssistantTools } from '@/lib/assistant/tools';
import { createTurnActions } from '@/lib/assistant/turn-actions';
import { askWithToolCalls, type ToolCallsTurn } from '../helpers/assistant-tool-turn';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionUserId: null as string | null,
  llm: null as unknown,
  /** Every request the text LLM was asked to write for a suggestion. */
  written: [] as unknown[],
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth', () => ({
  getAuth: () => ({
    api: {
      getSession: async () =>
        holder.sessionUserId
          ? { session: { id: 'live' }, user: { id: holder.sessionUserId } }
          : null,
    },
  }),
}));
vi.mock('@/lib/providers', () => ({
  getLlmProvider: async () => holder.llm,
  // Two Tracks per call: budgets are counted in calls and gated in Tracks.
  getTypicalTracksPerMusicRequest: () => 2,
  getMusicProvider: async () => ({ getCapabilities: () => ({ typicalTracksPerRequest: 2 }) }),
}));

const { POST } = await import('@/app/api/assistant/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

/**
 * A user under an id of their own. The route's burst limit and the Surprise
 * Me rate limit count per user id for as long as the process lives, so no two
 * tests share one.
 */
let users = 0;
async function createAdmin(): Promise<string> {
  users += 1;
  const id = `admin-${users}`;
  await testDb.db.insert(user).values({ id, name: id, email: `${id}@example.test` });
  await testDb.db.insert(userProfiles).values({ userId: id, role: 'admin' });
  return id;
}

/**
 * `userId` sends one message; the model calls `proposeSurprise` once per
 * input, all at once. The text LLM's tool-calling is scripted; writing and
 * expanding the suggestion is the mock text LLM's, as on Home.
 */
function askForSurprise(userId: string, ...inputs: unknown[]): Promise<ToolCallsTurn> {
  holder.sessionUserId = userId;
  const writer = mockLlmProvider();
  return askWithToolCalls(
    POST,
    (llm) => {
      holder.llm = {
        ...llm,
        async createSurpriseRequest(input: SurpriseRequestInput) {
          holder.written.push(input);
          return writer.createSurpriseRequest(input);
        },
        expandSessionIntentWithMetadata: writer.expandSessionIntentWithMetadata.bind(writer),
      };
    },
    inputs.map((input) => ({ name: 'proposeSurprise', input })),
  );
}

/** The cards a reply stream carried, in order. */
const cards = ({ events }: ToolCallsTurn): AssistantCard[] =>
  events.flatMap((event) =>
    event.type === 'action' && event.action.status === 'proposed' ? [event.action.card] : [],
  );

const surpriseCard = (turn: ToolCallsTurn) => {
  const [card] = cards(turn);
  if (card?.kind !== 'surprise') throw new Error('no Surprise Me card');
  return card;
};

async function rowsIn(table: 'activity_sessions' | 'generation_requests'): Promise<number> {
  const { rows } = await testDb.pool.query<{ n: number }>(
    `select count(*)::int as n from ${table}`,
  );
  return rows[0]!.n;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('assistant-prepares-a-surprise-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, [
    'surprise_proposals',
    'taste_evidence',
    'listening_preferences',
    ...GENERATION_FIXTURE_TABLES,
    'user_settings',
    'app_settings',
  ]);
  holder.sessionUserId = null;
  holder.written = [];
});

describe.skipIf(skip)('the Assistant asked to surprise the user', () => {
  it('prepares a suggestion that stays pending, sends its card, and starts nothing', async () => {
    const asker = await createAdmin();

    const turn = await askForSurprise(asker, {});

    const card = surpriseCard(turn);
    const pending = await getPendingProposal(testDb.db, asker);
    expect(pending?.id).toBe(card.suggestion.id);
    expect(card).toEqual({
      kind: 'surprise',
      suggestion: {
        id: pending!.id,
        adventurous: false,
        title: pending!.preview.title,
        mood: pending!.preview.mood,
        genres: pending!.preview.genres,
        energy: pending!.preview.energy,
        vocalMode: 'instrumental',
        voiceGender: null,
        language: pending!.preview.language,
      },
      // The length the app's Surprise Me card prefills.
      targetDurationMinutes: pending!.preview.durationMinutes,
      // The shipped cover-art settings, which Home's form starts it with.
      coverStyle: 'poster_art',
      useStandardCover: false,
    });
    expect(holder.written).toHaveLength(1);
    // The model is told what it prepared, and what confirming costs.
    expect(turn.results[0]).toMatch(/^Prepared: /);
    expect(turn.results[0]).toContain(JSON.stringify(pending!.preview.title));
    expect(turn.results[0]).toContain(JSON.stringify(pending!.preview.mood));
    expect(turn.results[0]).toMatch(/confirming generates new Tracks from their budget/);
    expect(await rowsIn('activity_sessions')).toBe(0);
    expect(await rowsIn('generation_requests')).toBe(0);
  });

  it('carries the cover choices Home’s form starts with: the user’s Default cover style and Standard covers', async () => {
    const asker = await createAdmin();
    await updateCoverArtSettings(testDb.db, asker, {
      defaultStyle: 'manga',
      useStandardCoverArt: true,
    });

    expect(surpriseCard(await askForSurprise(asker, {}))).toMatchObject({
      coverStyle: 'manga',
      useStandardCover: true,
    });
  });

  it('asks the app for what the user named: adventurous, a theme, vocals, a length', async () => {
    const asker = await createAdmin();

    const turn = await askForSurprise(asker, {
      adventurous: true,
      theme: 'morning',
      vocal: 'vocal',
      targetDurationMinutes: 60,
    });

    const card = surpriseCard(turn);
    expect(card.suggestion.adventurous).toBe(true);
    expect(card.suggestion.vocalMode).toBe('vocal');
    expect(card.targetDurationMinutes).toBe(60);
    expect(holder.written).toHaveLength(1);
    expect(JSON.stringify(holder.written[0])).toMatch(/morning/i);
  });

  it('prepares one with no limit only when the user asked for that', async () => {
    const asker = await createAdmin();

    const turn = await askForSurprise(asker, { noLimit: true });

    expect(surpriseCard(turn).targetDurationMinutes).toBeNull();
    expect(turn.results[0]).toMatch(/with no limit/);
  });

  it('shows no card for no limit when the user’s new Sessions start on Repeat, and writes nothing', async () => {
    const asker = await createAdmin();
    await updateGenerationSettings(testDb.db, {
      ownerUserId: asker,
      patch: { bufferEnabled: false },
    });

    const turn = await askForSurprise(asker, { noLimit: true });

    expect(cards(turn)).toEqual([]);
    expect(turn.results[0]).toMatch(/repeats them/i);
    expect(turn.results[0]).toMatch(/no card was shown/i);
    expect(holder.written).toEqual([]);
  });

  it('replaces the pending suggestion when asked again, so one stays pending', async () => {
    const asker = await createAdmin();
    const first = surpriseCard(await askForSurprise(asker, {}));

    const second = surpriseCard(await askForSurprise(asker, {}));

    expect(second.suggestion.id).not.toBe(first.suggestion.id);
    expect((await getPendingProposal(testDb.db, asker))?.id).toBe(second.suggestion.id);
  });

  it('gives the model the app’s refusal and sends no card when the budget is used up', async () => {
    const asker = await createAdmin();
    await updateUsageLimits(testDb.db, {
      trackCeilingEnabled: true,
      dailyGenerationTasks: 2,
      monthlyGenerationTasks: 400,
      minHeadroomTracksToStartSession: 4,
      resetTimezone: 'UTC',
    });
    for (let i = 0; i < 2; i += 1) {
      const generationRequestId = await createGenerationRequest(testDb.db, { ownerUserId: asker });
      await createProviderJob(testDb.db, { generationRequestId });
    }

    const turn = await askForSurprise(asker, {});

    expect(cards(turn)).toEqual([]);
    expect(turn.results[0]).toContain('You have reached your generation headroom for now.');
    expect(turn.results[0]).toMatch(/no card was shown/i);
    expect(holder.written).toEqual([]);
    expect(await getPendingProposal(testDb.db, asker)).toBeNull();
  });

  it('keeps nothing when the user stops the answer while the suggestion is being written', async () => {
    const asker = await createAdmin();
    const first = surpriseCard(await askForSurprise(asker, {}));
    const stop = new AbortController();
    const writer = mockLlmProvider();
    holder.llm = {
      ...writer,
      async createSurpriseRequest(input: SurpriseRequestInput) {
        stop.abort();
        return writer.createSurpriseRequest(input);
      },
    };
    const reported: unknown[] = [];
    const proposeTool = createAssistantTools(
      { db: testDb.db, userId: asker, role: 'admin', player: null, signal: stop.signal },
      createTurnActions((action) => reported.push(action)),
      [],
    ).find((tool) => tool.name === 'proposeSurprise')!;

    await proposeTool.execute({});

    expect(reported).toEqual([]);
    expect((await getPendingProposal(testDb.db, asker))?.id).toBe(first.suggestion.id);
  });

  it('prepares one card per message: a second ask writes nothing', async () => {
    const asker = await createAdmin();

    const turn = await askForSurprise(asker, {}, { adventurous: true });

    expect(cards(turn)).toHaveLength(1);
    expect(turn.results[1]).toMatch(/only one card can be prepared.*no second card/i);
    expect(holder.written).toHaveLength(1);
  });

  it.each([
    ['a length the app does not take', { targetDurationMinutes: 601 }],
    ['a length that is not whole minutes', { targetDurationMinutes: 7.5 }],
  ])('tells the model about %s, writes nothing and sends no card', async (_what, input) => {
    const asker = await createAdmin();

    const turn = await askForSurprise(asker, input);

    expect(cards(turn)).toEqual([]);
    expect(turn.results[0]).toMatch(/no card was shown/i);
    expect(holder.written).toEqual([]);
  });
});
