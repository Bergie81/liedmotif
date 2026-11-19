// What happens when the Assistant's model asks for a new cover: the tool asks
// the app's read-only cover gate, and the reply stream carries a card for the
// asker's own Session or Playlist. Nothing is reserved or generated. The
// route, the tool and the gate run against a real database; a scripted model
// stands in for the text LLM.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activitySessions,
  createPlaylist,
  reserveSessionCoverRegeneration,
  sessionCoverGenerations,
  setPlaylistShared,
  updateMemberLimits,
  updateUsageLimits,
  user,
  userProfiles,
} from '@liedmotif/db';
import {
  connectTestDb,
  createSession,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import {
  MAX_COVER_GUIDANCE_LENGTH,
  type AssistantCard,
  type AssistantPlayerState,
} from '@liedmotif/shared';
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
  getTypicalTracksPerMusicRequest: () => 2,
  getMusicProvider: async () => ({ getCapabilities: () => ({ typicalTracksPerRequest: 2 }) }),
}));

const { POST } = await import('@/app/api/assistant/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

const UNKNOWN_ID = '7b0a1c5e-3f0d-4a55-9d0e-2f6f3f1f8a11';

/**
 * A Member under an id of their own. The route's burst limit counts per user
 * id for as long as the process lives, so no two tests share one.
 */
let members = 0;
async function createMember(): Promise<string> {
  members += 1;
  const id = `coverer-${members}`;
  await testDb.db.insert(user).values({ id, name: 'Coverer', email: `${id}@example.test` });
  await testDb.db.insert(userProfiles).values({ userId: id, role: 'member' });
  return id;
}

const seedSession = (ownerUserId: string, title: string) =>
  createSession(testDb.db, { ownerUserId, title, status: 'stopped' });

async function seedPlaylist(ownerUserId: string, name: string): Promise<string> {
  return (await createPlaylist(testDb.db, { ownerUserId, name })).id;
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

const proposeCover = (input: unknown) => ({ name: 'proposeCover', input });

/** The cards a reply stream carried, in order. */
const cards = ({ events }: ToolCallsTurn): AssistantCard[] =>
  events.flatMap((event) =>
    event.type === 'action' && event.action.status === 'proposed' ? [event.action.card] : [],
  );

/** Every cover attempt there is: reserved, generating or settled. */
async function coverAttempts(): Promise<number> {
  return (await testDb.db.select({ id: sessionCoverGenerations.id }).from(sessionCoverGenerations))
    .length;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('assistant-prepares-a-cover-test');
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
    'cover_images',
    'user_settings',
    'app_settings',
  ]);
  holder.sessionUserId = null;
  vi.stubEnv('IMAGE_PROVIDER', 'openrouter');
  vi.stubEnv('IMAGE_API_KEY', 'test-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.skipIf(skip)('the Assistant asked for a new cover', () => {
  it('offers a card for a Session with the art direction, and reserves nothing', async () => {
    const asker = await createMember();
    const sessionId = await seedSession(asker, 'Rainy Window');

    const turn = await ask(asker, [
      proposeCover({ in: 'session', id: sessionId, guidance: '  darker, neon city ' }),
    ]);

    expect(cards(turn)).toEqual([
      {
        kind: 'cover',
        subject: { kind: 'session', id: sessionId, name: 'Rainy Window' },
        guidance: 'darker, neon city',
      },
    ]);
    expect(turn.results[0]).toMatch(
      /^Prepared: a card to generate one new cover for the Session "Rainy Window" with the art direction "darker, neon city"\. Nothing has started and nothing is spent/,
    );
    expect(turn.results[0]).toMatch(/confirming generates one cover from their cover budget/);
    expect(await coverAttempts()).toBe(0);
  });

  it('offers a card for a Playlist of the asker’s own without art direction', async () => {
    const asker = await createMember();
    const playlistId = await seedPlaylist(asker, 'Running');

    const turn = await ask(asker, [proposeCover({ in: 'playlist', id: playlistId })]);

    expect(cards(turn)).toEqual([
      { kind: 'cover', subject: { kind: 'playlist', id: playlistId, name: 'Running' } },
    ]);
    expect(turn.results[0]).toMatch(
      /^Prepared: a card to generate one new cover for the Playlist "Running"\. /,
    );
    expect(await coverAttempts()).toBe(0);
  });

  it('takes "this" from what the player has on, and asks when it has nothing of that kind', async () => {
    const asker = await createMember();
    const sessionId = await seedSession(asker, 'Rainy Window');
    const playlistId = await seedPlaylist(asker, 'Running');
    const onSession = {
      source: { kind: 'session', id: sessionId },
      trackId: null,
      playing: true,
    } as const;
    const onPlaylist = {
      source: { kind: 'playlist', id: playlistId },
      trackId: null,
      playing: true,
    } as const;

    const forSession = await ask(asker, [proposeCover({ in: 'session' })], onSession);
    const forPlaylist = await ask(asker, [proposeCover({ in: 'playlist' })], onPlaylist);
    const nothingOn = await ask(asker, [proposeCover({ in: 'session' })]);
    const otherKind = await ask(asker, [proposeCover({ in: 'playlist' })], onSession);

    expect(cards(forSession)).toMatchObject([{ subject: { kind: 'session', id: sessionId } }]);
    expect(cards(forPlaylist)).toMatchObject([{ subject: { kind: 'playlist', id: playlistId } }]);
    expect(nothingOn.results[0]).toMatch(
      /no session is playing.*ask the user which session.*no card was shown/i,
    );
    expect(otherKind.results[0]).toMatch(
      /no playlist is playing.*ask the user which playlist.*no card was shown/i,
    );
    expect([...cards(nothingOn), ...cards(otherKind)]).toEqual([]);
  });

  it('refuses another user’s Session, one being deleted and an unknown id alike', async () => {
    const asker = await createMember();
    const theirs = await seedSession(await createMember(), 'Private');
    const deleting = await seedSession(asker, 'Leaving');
    await testDb.db
      .update(activitySessions)
      .set({ deleteRequestedAt: new Date() })
      .where(eq(activitySessions.id, deleting));

    for (const id of [theirs, deleting, UNKNOWN_ID, 'focus']) {
      const turn = await ask(asker, [proposeCover({ in: 'session', id })]);

      expect(turn.results).toEqual(['No Session with that id. No card was shown.']);
      expect(cards(turn)).toEqual([]);
    }
  });

  it('refuses a Playlist shared with the asker in the Lounge like one that does not exist', async () => {
    const asker = await createMember();
    const other = await createMember();
    const shared = await seedPlaylist(other, 'Night Owls');
    await setPlaylistShared(testDb.db, {
      ownerUserId: other,
      playlistId: shared,
      audience: { kind: 'everyone' },
    });

    for (const id of [shared, UNKNOWN_ID]) {
      const turn = await ask(asker, [proposeCover({ in: 'playlist', id })]);

      expect(turn.results).toEqual(['No Playlist of this user with that id. No card was shown.']);
      expect(cards(turn)).toEqual([]);
    }
  });

  it('refuses art direction longer than the cover dialog takes, and says why', async () => {
    const asker = await createMember();
    const sessionId = await seedSession(asker, 'Rainy Window');

    const turn = await ask(asker, [
      proposeCover({
        in: 'session',
        id: sessionId,
        guidance: 'x'.repeat(MAX_COVER_GUIDANCE_LENGTH + 1),
      }),
    ]);

    expect(turn.results[0]).toBe(
      `Art direction has at most ${MAX_COVER_GUIDANCE_LENGTH} characters. No card was shown.`,
    );
    expect(cards(turn)).toEqual([]);
  });

  it.each([
    [
      'no image provider is set up',
      async () => vi.stubEnv('IMAGE_PROVIDER', ''),
      'No image provider is set up on this server. Ask the Admin to add one.',
    ],
    [
      'Tailored Cover Art is switched off',
      async () => updateUsageLimits(testDb.db, { tailoredCoverArtEnabled: false }),
      'Tailored Cover Art is turned off on this server. Ask the Admin to turn it on.',
    ],
    [
      'the cover budget is used up',
      async (asker: string) =>
        updateMemberLimits(testDb.db, { ownerUserId: asker, patch: { generatedCoversPerDay: 0 } }),
      'The cover generation limit is reached for this window.',
    ],
  ])('gives the app’s own refusal and no card when %s', async (_when, arrange, message) => {
    const asker = await createMember();
    const sessionId = await seedSession(asker, 'Rainy Window');
    await arrange(asker);

    const turn = await ask(asker, [proposeCover({ in: 'session', id: sessionId })]);

    expect(turn.results[0]).toBe(`${message} No card was shown.`);
    expect(cards(turn)).toEqual([]);
  });

  it('says a cover is already being generated instead of offering a second one', async () => {
    const asker = await createMember();
    const sessionId = await seedSession(asker, 'Rainy Window');
    const coverImageId = randomUUID();
    await reserveSessionCoverRegeneration(testDb.db, {
      id: randomUUID(),
      ownerUserId: asker,
      activitySessionId: sessionId,
      coverImageId,
      storageKey: `covers/generated/${asker}/${sessionId}/${coverImageId}.webp`,
    });

    const turn = await ask(asker, [proposeCover({ in: 'session', id: sessionId })]);

    expect(turn.results[0]).toMatch(/already being generated for the Session "Rainy Window"/);
    expect(turn.results[0]).toMatch(/No card was shown\.$/);
    expect(cards(turn)).toEqual([]);
    expect(await coverAttempts()).toBe(1);
  });

  it('shares the one card a message may lead to with every other kind of card', async () => {
    const asker = await createMember();
    const sessionId = await seedSession(asker, 'Rainy Window');

    const turn = await ask(asker, [
      proposeCover({ in: 'session', id: sessionId }),
      { name: 'proposeSession', input: { prompt: 'rainy lo-fi', noLimit: true } },
    ]);

    expect(cards(turn)).toHaveLength(1);
    expect(turn.results.filter((told) => /Only one card can be prepared/.test(told))).toHaveLength(
      1,
    );
  });
});
