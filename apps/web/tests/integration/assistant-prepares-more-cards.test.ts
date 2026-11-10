// What happens when the Assistant's model asks for one of the other things
// that can spend: a Change Vibe, a More Like This, New music on. The reply
// stream carries a card, and nothing is changed, created or bought. The route,
// the tools and the app's own gates run against a real database; a scripted
// model stands in for the text LLM.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPlaylistTracks,
  createPlaylist,
  getSessionById,
  setPlaylistShared,
  updateUsageLimits,
  user,
  userProfiles,
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
import type { AssistantCard, AssistantPlayerState } from '@liedmotif/shared';
import { askWithToolCalls, type ToolCallsTurn } from '../helpers/assistant-tool-turn';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionUserId: null as string | null,
  llm: null as unknown,
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
 * A user under an id of their own. The route's burst limit counts per user id
 * for as long as the process lives, so no two tests share one.
 */
let users = 0;
async function createUser(role: 'admin' | 'member' = 'admin'): Promise<string> {
  users += 1;
  const id = `${role}-${users}`;
  await testDb.db.insert(user).values({ id, name: id, email: `${id}@example.test` });
  await testDb.db.insert(userProfiles).values({ userId: id, role });
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

/** One Track of `minutes` in `sessionId`, which counts towards its duration target. */
async function seedTrack(
  ownerUserId: string,
  sessionId: string,
  title: string,
  minutes = 3,
): Promise<string> {
  const generationRequestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const providerJobId = await createProviderJob(testDb.db, { generationRequestId });
  return createTrack(testDb.db, {
    ownerUserId,
    generationRequestId,
    providerJobId,
    title,
    durationSeconds: minutes * 60,
    audioStorageKey: `audio/${generationRequestId}.mp3`,
  });
}

/** `userId` sends one message; the model calls every one of `calls` at once. */
function ask(
  userId: string,
  calls: { name: string; input: unknown }[],
  player?: AssistantPlayerState,
): Promise<ToolCallsTurn> {
  holder.sessionUserId = userId;
  return askWithToolCalls(
    POST,
    (llm) => {
      holder.llm = llm;
    },
    calls,
    { player },
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

const sessionOf = (ownerUserId: string, sessionId: string) =>
  getSessionById(testDb.db, { ownerUserId, sessionId });

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('assistant-prepares-more-cards-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, [
    'playlist_tracks',
    'playlists',
    ...GENERATION_FIXTURE_TABLES,
    'user_settings',
    'app_settings',
  ]);
  holder.sessionUserId = null;
});

describe.skipIf(skip)('the Assistant asked to change the vibe', () => {
  const changeVibe = (input: unknown) => ({ name: 'proposeChangeVibe', input });

  it('sends a card for the active Session with the words the click will send, and changes nothing', async () => {
    const asker = await createUser();
    const sessionId = await createSession(testDb.db, {
      ownerUserId: asker,
      title: 'Rainy Window',
      userPrompt: 'rain on glass',
    });
    const before = await sessionOf(asker, sessionId);

    const turn = await ask(asker, [changeVibe({ prompt: '  slower, with a cello ' })]);

    expect(cards(turn)).toEqual([
      {
        kind: 'changeVibe',
        session: { id: sessionId, name: 'Rainy Window' },
        prompt: 'slower, with a cello',
      },
    ]);
    expect(turn.results[0]).toMatch(
      /^Prepared: a card to change the vibe of the Session "Rainy Window"/,
    );
    expect(turn.results[0]).toMatch(/nothing (has|is) started/i);
    const after = await sessionOf(asker, sessionId);
    expect(after!.styleRevision).toBe(before!.styleRevision);
    expect(after!.userPrompt).toBe('rain on glass');
    expect(await rowsIn('generation_requests')).toBe(0);
  });

  it('says there is no active Session, and sends no card for a stopped one', async () => {
    const asker = await createUser();
    await createSession(testDb.db, { ownerUserId: asker, status: 'stopped' });

    const turn = await ask(asker, [changeVibe({ prompt: 'slower' })]);

    expect(cards(turn)).toEqual([]);
    expect(turn.results[0]).toMatch(/no active session/i);
    expect(turn.results[0]).toMatch(/no card was shown/i);
  });

  it('never offers another user’s active Session', async () => {
    const asker = await createUser('member');
    const other = await createUser('member');
    await createSession(testDb.db, { ownerUserId: other, title: 'Theirs' });

    const turn = await ask(asker, [changeVibe({ prompt: 'slower' })]);

    expect(cards(turn)).toEqual([]);
    expect(turn.results[0]).toMatch(/no active session/i);
    expect(turn.results[0]).not.toContain('Theirs');
  });

  it('gives the model the app’s refusal and sends no card when not one more call fits the budget', async () => {
    const asker = await createUser();
    await createSession(testDb.db, { ownerUserId: asker });
    await setDailyCeiling(2, 4);
    await spendCalls(asker, 2);

    const turn = await ask(asker, [changeVibe({ prompt: 'slower' })]);

    expect(cards(turn)).toEqual([]);
    expect(turn.results[0]).toContain('You have reached your generation headroom for now.');
    expect(turn.results[0]).toMatch(/no card was shown/i);
  });

  it('still offers the card below the headroom a new Session needs, as the Change Vibe route does', async () => {
    const asker = await createUser();
    await createSession(testDb.db, { ownerUserId: asker });
    // One call left: 2 Tracks, fewer than the 4 a new Session needs.
    await setDailyCeiling(2, 4);
    await spendCalls(asker, 1);

    const turn = await ask(asker, [changeVibe({ prompt: 'slower' })]);

    expect(cards(turn)).toMatchObject([{ kind: 'changeVibe', prompt: 'slower' }]);
  });

  it('gives the model the app’s refusal and sends no card when the duration target is reached', async () => {
    const asker = await createUser();
    const sessionId = await createSession(testDb.db, {
      ownerUserId: asker,
      targetDurationMinutes: 5,
    });
    await seedTrack(asker, sessionId, 'One', 3);
    await seedTrack(asker, sessionId, 'Two', 3);

    const turn = await ask(asker, [changeVibe({ prompt: 'slower' })]);

    expect(cards(turn)).toEqual([]);
    expect(turn.results[0]).toContain('Duration target reached');
    expect(turn.results[0]).toMatch(/no card was shown/i);
  });

  it('tells the model about words it cannot send, and sends no card', async () => {
    const asker = await createUser();
    await createSession(testDb.db, { ownerUserId: asker });

    const turn = await ask(asker, [changeVibe({ prompt: '   ' })]);

    expect(cards(turn)).toEqual([]);
    expect(turn.results[0]).toMatch(/no card was shown/i);
  });
});

describe.skipIf(skip)('the Assistant asked for more like some Tracks', () => {
  const moreLikeThis = (input: unknown) => ({ name: 'proposeMoreLikeThis', input });

  /** One Track per title in a stopped Session of `ownerUserId`. */
  async function seedTracks(ownerUserId: string, ...titles: string[]): Promise<string[]> {
    const sessionId = await createSession(testDb.db, { ownerUserId, status: 'stopped' });
    const trackIds: string[] = [];
    for (const title of titles) trackIds.push(await seedTrack(ownerUserId, sessionId, title));
    return trackIds;
  }

  it('sends a card naming the asker’s own Tracks in the order given, and creates nothing', async () => {
    const asker = await createUser();
    const [nightDrive, lowTide] = await seedTracks(asker, 'Night Drive', 'Low Tide');
    const sessions = await rowsIn('activity_sessions');
    const requests = await rowsIn('generation_requests');

    const turn = await ask(asker, [moreLikeThis({ trackIds: [lowTide, nightDrive] })]);

    expect(cards(turn)).toEqual([
      {
        kind: 'moreLikeThis',
        tracks: [
          { id: lowTide, name: 'Low Tide' },
          { id: nightDrive, name: 'Night Drive' },
        ],
      },
    ]);
    expect(turn.results[0]).toMatch(
      /^Prepared: a card to start a new Session that sounds like the Tracks "Low Tide", "Night Drive"/,
    );
    expect(await rowsIn('activity_sessions')).toBe(sessions);
    expect(await rowsIn('generation_requests')).toBe(requests);
  });

  it('takes "this" from what the player has on the deck when the model names no Track', async () => {
    const asker = await createUser();
    const sessionId = await createSession(testDb.db, { ownerUserId: asker });
    const trackId = await seedTrack(asker, sessionId, 'On The Deck');

    const turn = await ask(asker, [moreLikeThis({})], {
      source: { kind: 'session', id: sessionId },
      trackId,
      playing: true,
    });

    expect(cards(turn)).toEqual([
      { kind: 'moreLikeThis', tracks: [{ id: trackId, name: 'On The Deck' }] },
    ]);
  });

  it('says so, and sends no card, when no Track is named and nothing is playing', async () => {
    const asker = await createUser();

    const turn = await ask(asker, [moreLikeThis({})]);

    expect(cards(turn)).toEqual([]);
    expect(turn.results[0]).toMatch(/no track is playing/i);
    expect(turn.results[0]).toMatch(/no card was shown/i);
  });

  it('does not accept another user’s Track as a seed, alone or among the asker’s own', async () => {
    const asker = await createUser('member');
    const other = await createUser('member');
    const [mine] = await seedTracks(asker, 'Mine');
    const [theirs] = await seedTracks(other, 'Theirs');

    const alone = await ask(asker, [moreLikeThis({ trackIds: [theirs] })]);
    const among = await ask(asker, [moreLikeThis({ trackIds: [mine, theirs] })]);
    const unknown = await ask(asker, [
      moreLikeThis({ trackIds: ['00000000-0000-4000-8000-00000000dead'] }),
    ]);

    for (const turn of [alone, among]) {
      expect(cards(turn)).toEqual([]);
      expect(turn.results[0]).not.toContain('Theirs');
      // A private Track of someone else reads like one that does not exist.
      expect(turn.results[0]).toBe(unknown.results[0]);
    }
    expect(unknown.results[0]).toMatch(/no card was shown/i);
  });

  it('takes a Track shared with the asker in the Lounge, as the app’s own More Like This does', async () => {
    const asker = await createUser('member');
    const owner = await createUser('member');
    const [shared] = await seedTracks(owner, 'Moonlit');
    const playlist = await createPlaylist(testDb.db, { ownerUserId: owner, name: 'Night Owls' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: owner,
      playlistId: playlist.id,
      trackIds: [shared!],
    });
    await setPlaylistShared(testDb.db, {
      ownerUserId: owner,
      playlistId: playlist.id,
      audience: { kind: 'everyone' },
    });

    const turn = await ask(asker, [moreLikeThis({ trackIds: [shared] })]);

    expect(cards(turn)).toEqual([
      { kind: 'moreLikeThis', tracks: [{ id: shared, name: 'Moonlit' }] },
    ]);
  });

  it('gives the model the app’s refusal and sends no card below the headroom a new Session needs', async () => {
    const asker = await createUser();
    const [trackId] = await seedTracks(asker, 'Night Drive');
    // The seed's own call is spent, so one is left: 2 Tracks, fewer than the 4 a new Session needs.
    await setDailyCeiling(2, 4);

    const turn = await ask(asker, [moreLikeThis({ trackIds: [trackId] })]);

    expect(cards(turn)).toEqual([]);
    expect(turn.results[0]).toContain('You have reached your generation headroom for now.');
    expect(turn.results[0]).toMatch(/no card was shown/i);
  });

  it('tells the model about more Tracks than a Session is seeded from, and sends no card', async () => {
    const asker = await createUser();
    const trackIds = await seedTracks(asker, ...Array.from({ length: 11 }, (_, i) => `T${i}`));

    const turn = await ask(asker, [moreLikeThis({ trackIds })]);

    expect(cards(turn)).toEqual([]);
    expect(turn.results[0]).toMatch(/at most 10 Tracks/);
    expect(turn.results[0]).toMatch(/no card was shown/i);
  });
});

describe.skipIf(skip)('the Assistant asked to switch New music on', () => {
  const newMusicOn = (input: unknown) => ({ name: 'proposeNewMusicOn', input });

  it('sends a card for the active Session with the duration the click will save, and switches nothing', async () => {
    const asker = await createUser();
    const sessionId = await createSession(testDb.db, {
      ownerUserId: asker,
      title: 'Rainy Window',
      sessionMode: 'repeat',
    });

    const turn = await ask(asker, [newMusicOn({ targetDurationMinutes: 90 })]);

    expect(cards(turn)).toEqual([
      {
        kind: 'newMusicOn',
        session: { id: sessionId, name: 'Rainy Window' },
        targetDurationMinutes: 90,
      },
    ]);
    expect(turn.results[0]).toMatch(
      /^Prepared: a card to switch New music on for the Session "Rainy Window", up to 90 minutes of music/,
    );
    const after = await sessionOf(asker, sessionId);
    expect(after).toMatchObject({ sessionMode: 'repeat', targetDurationMinutes: null });
  });

  it('prepares No limit as the route reads it: a cleared target', async () => {
    const asker = await createUser();
    const sessionId = await createSession(testDb.db, {
      ownerUserId: asker,
      title: 'Loop',
      sessionMode: 'repeat',
      targetDurationMinutes: 30,
    });

    const turn = await ask(asker, [newMusicOn({ noLimit: true })]);

    expect(cards(turn)).toEqual([
      { kind: 'newMusicOn', session: { id: sessionId, name: 'Loop' }, targetDurationMinutes: null },
    ]);
    expect(await sessionOf(asker, sessionId)).toMatchObject({
      sessionMode: 'repeat',
      targetDurationMinutes: 30,
    });
  });

  it('offers a new target for a Session that already generates', async () => {
    const asker = await createUser();
    await createSession(testDb.db, { ownerUserId: asker, targetDurationMinutes: 60 });

    const turn = await ask(asker, [newMusicOn({ targetDurationMinutes: 120 })]);

    expect(cards(turn)).toMatchObject([{ kind: 'newMusicOn', targetDurationMinutes: 120 }]);
  });

  it.each([
    ['neither a length nor No limit', {}],
    ['both a length and No limit', { targetDurationMinutes: 60, noLimit: true }],
    ['a length the app does not take', { targetDurationMinutes: 601 }],
    ['a length that is not whole minutes', { targetDurationMinutes: 7.5 }],
  ])('asks the model to ask the user about %s, and sends no card', async (_what, input) => {
    const asker = await createUser();
    await createSession(testDb.db, { ownerUserId: asker, sessionMode: 'repeat' });

    const turn = await ask(asker, [newMusicOn(input)]);

    expect(cards(turn)).toEqual([]);
    expect(turn.results[0]).toMatch(/whole number from 1 to 600 minutes, or no limit/i);
    expect(turn.results[0]).toMatch(/no card was shown/i);
  });

  it('says there is no active Session, and sends no card for a stopped one', async () => {
    const asker = await createUser();
    await createSession(testDb.db, { ownerUserId: asker, status: 'stopped' });

    const turn = await ask(asker, [newMusicOn({ noLimit: true })]);

    expect(cards(turn)).toEqual([]);
    expect(turn.results[0]).toMatch(/no active session/i);
    expect(turn.results[0]).toMatch(/no card was shown/i);
  });

  it.each([
    ['with no limit', null, { noLimit: true }, /already on for the Session "Loop", with no limit/],
    ['up to 60 minutes', 60, { targetDurationMinutes: 60 }, /already on .* up to 60 minutes/],
  ])('says New music is already on %s, and sends no card', async (_what, target, input, told) => {
    const asker = await createUser();
    await createSession(testDb.db, {
      ownerUserId: asker,
      title: 'Loop',
      targetDurationMinutes: target,
    });

    const turn = await ask(asker, [newMusicOn(input)]);

    expect(cards(turn)).toEqual([]);
    expect(turn.results[0]).toMatch(told);
    expect(turn.results[0]).toMatch(/no card was shown/i);
  });

  it('tells the model when the Session already holds the length asked for, and sends no card', async () => {
    const asker = await createUser();
    const sessionId = await createSession(testDb.db, {
      ownerUserId: asker,
      title: 'Loop',
      sessionMode: 'repeat',
    });
    await seedTrack(asker, sessionId, 'One', 3);
    await seedTrack(asker, sessionId, 'Two', 3);

    const reached = await ask(asker, [newMusicOn({ targetDurationMinutes: 6 })]);
    const above = await ask(asker, [newMusicOn({ targetDurationMinutes: 7 })]);

    expect(cards(reached)).toEqual([]);
    expect(reached.results[0]).toMatch(/already holds 6 minutes of music/);
    expect(reached.results[0]).toMatch(/no card was shown/i);
    expect(cards(above)).toMatchObject([{ kind: 'newMusicOn', targetDurationMinutes: 7 }]);
  });

  it('gives the model the app’s refusal and sends no card when not one more call fits the budget', async () => {
    const asker = await createUser();
    await createSession(testDb.db, { ownerUserId: asker, sessionMode: 'repeat' });
    await setDailyCeiling(2, 4);
    await spendCalls(asker, 2);

    const turn = await ask(asker, [newMusicOn({ noLimit: true })]);

    expect(cards(turn)).toEqual([]);
    expect(turn.results[0]).toContain('You have reached your generation headroom for now.');
    expect(turn.results[0]).toMatch(/no card was shown/i);
  });
});

describe.skipIf(skip)('one message to the Assistant', () => {
  it('leads to at most one card, whatever the kinds asked for', async () => {
    const asker = await createUser();
    await createSession(testDb.db, { ownerUserId: asker, title: 'Loop', sessionMode: 'repeat' });

    const turn = await ask(asker, [
      { name: 'proposeNewMusicOn', input: { noLimit: true } },
      { name: 'proposeChangeVibe', input: { prompt: 'slower' } },
      { name: 'proposeSession', input: { prompt: 'calm piano' } },
    ]);

    expect(cards(turn)).toHaveLength(1);
    const refusals = turn.results.filter((result) => /already prepared a card/i.test(result));
    expect(refusals).toHaveLength(2);
  });
});
