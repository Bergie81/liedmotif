// What the Assistant hands to the browser's player when its model asks to play
// something: a play command for a Session, a Playlist or a Track the asking
// user can play, or a reason and no command when there is nothing to play.
// The route and the tools run against a real database; a scripted model stands
// in for the text LLM. The player itself lives in the browser and is not here:
// the tool only reads, and these tests pin that it changes nothing.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activitySessions,
  addPlaylistTracks,
  createPlaylist,
  setPlaylistShared,
  user,
  userProfiles,
} from '@liedmotif/db';
import {
  connectTestDb,
  createSession,
  GENERATION_FIXTURE_TABLES,
  seedSessionTrack,
  TEST_DATABASE_URL,
  truncateTables,
  type SessionFixture,
  type TestDb,
} from '@liedmotif/db/testing';
import type { AssistantPlayerCommand, AssistantPlayerState } from '@liedmotif/shared';
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
  const id = `listener-${members}`;
  await testDb.db.insert(user).values({ id, name: 'Listener', email: `${id}@example.test` });
  await testDb.db.insert(userProfiles).values({ userId: id, role: 'member' });
  return id;
}

type TrackSeed = NonNullable<Parameters<typeof seedSessionTrack>[3]>;

/** A Session of `ownerUserId`, stopped unless `session` says otherwise, with one Track per seed. */
async function seedSession(
  ownerUserId: string,
  title: string,
  tracks: TrackSeed[],
  session: Partial<SessionFixture> = {},
): Promise<{ sessionId: string; trackIds: string[] }> {
  const sessionId = await createSession(testDb.db, {
    ownerUserId,
    title,
    status: 'stopped',
    ...session,
  });
  const trackIds: string[] = [];
  for (const track of tracks) {
    trackIds.push(await seedSessionTrack(testDb.db, ownerUserId, sessionId, track));
  }
  return { sessionId, trackIds };
}

/** A Playlist of `ownerUserId` holding, in this order, one new Track per seed. */
async function seedPlaylist(
  ownerUserId: string,
  name: string,
  tracks: TrackSeed[],
): Promise<{ playlistId: string; trackIds: string[] }> {
  const { trackIds } = await seedSession(ownerUserId, `${name} source`, tracks);
  const playlist = await createPlaylist(testDb.db, { ownerUserId, name });
  if (trackIds.length > 0) {
    await addPlaylistTracks(testDb.db, { ownerUserId, playlistId: playlist.id, trackIds });
  }
  return { playlistId: playlist.id, trackIds };
}

/** `userId` sends one message with `player` engaged; the model calls every one of `calls` at once. */
function act(
  userId: string,
  player: AssistantPlayerState | undefined,
  ...calls: { name: string; input: unknown }[]
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

const play = (input: unknown) => ({ name: 'play', input });

/** The commands a reply stream handed to the player, in order. */
const commands = ({ events }: ToolCallsTurn): AssistantPlayerCommand[] =>
  events.flatMap((event) =>
    event.type === 'action' && event.action.status === 'player' ? [event.action.command] : [],
  );

/** Every Session row as the tests care about it: a play tool that only reads leaves these alone. */
const sessionRows = () =>
  testDb.db
    .select({
      id: activitySessions.id,
      status: activitySessions.status,
      sessionMode: activitySessions.sessionMode,
    })
    .from(activitySessions)
    .orderBy(activitySessions.id);

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('assistant-plays-music-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, [
    'playlist_pins',
    'playlist_tracks',
    'playlists',
    ...GENERATION_FIXTURE_TABLES,
    'user_settings',
    'app_settings',
  ]);
  holder.sessionUserId = null;
});

describe.skipIf(skip)('the Assistant asked to play a Playlist', () => {
  it('hands the player the Playlist by id, name and size, and tells the model so', async () => {
    const asker = await createMember();
    const running = await seedPlaylist(asker, 'Running', [
      { title: 'Night Drive' },
      { title: 'Open Road' },
    ]);

    const turn = await act(asker, undefined, play({ kind: 'playlist', id: running.playlistId }));

    expect(commands(turn)).toEqual([
      {
        name: 'play',
        source: {
          kind: 'playlist',
          id: running.playlistId,
          name: 'Running',
          trackCount: 2,
          foreign: false,
        },
      },
    ]);
    expect(turn.results[0]).toBe('Done: the player was told to play the Playlist "Running".');
    expect(turn.events.at(-1)).toEqual({ type: 'done' });
  });

  it("plays another user's Playlist from the Lounge as a Visitor does", async () => {
    const asker = await createMember();
    const owner = await createMember();
    const shared = await seedPlaylist(owner, 'Night Owls', [{ title: 'Moonlit' }]);
    await setPlaylistShared(testDb.db, {
      ownerUserId: owner,
      playlistId: shared.playlistId,
      audience: { kind: 'everyone' },
    });

    const turn = await act(asker, undefined, play({ kind: 'playlist', id: shared.playlistId }));

    expect(commands(turn)).toEqual([
      {
        name: 'play',
        source: {
          kind: 'playlist',
          id: shared.playlistId,
          name: 'Night Owls',
          trackCount: 1,
          foreign: true,
        },
      },
    ]);
  });

  it('starts at one Track of the Playlist when given its id', async () => {
    const asker = await createMember();
    const running = await seedPlaylist(asker, 'Running', [
      { title: 'Night Drive' },
      { title: 'Open Road' },
    ]);

    const turn = await act(
      asker,
      undefined,
      play({ kind: 'playlist', id: running.playlistId, trackId: running.trackIds[1] }),
    );

    expect(commands(turn)).toMatchObject([
      {
        name: 'play',
        source: { kind: 'playlist', id: running.playlistId },
        track: { id: running.trackIds[1], name: 'Open Road' },
      },
    ]);
    expect(turn.results[0]).toBe(
      'Done: the player was told to play the Track "Open Road" in the Playlist "Running".',
    );
  });

  it('sends nothing for a Playlist with nothing to play, and says why', async () => {
    const asker = await createMember();
    const empty = await seedPlaylist(asker, 'Someday', []);
    const silent = await seedPlaylist(asker, 'Not Ready', [{ title: 'Soon', playable: false }]);

    for (const { playlistId } of [empty, silent]) {
      const turn = await act(asker, undefined, play({ kind: 'playlist', id: playlistId }));

      expect(commands(turn)).toEqual([]);
      expect(turn.results[0]).toMatch(
        /^The Playlist "(Someday|Not Ready)" has no Track that can be played\. The player was left as it is\.$/,
      );
    }
  });

  it('sends nothing for a Track that is not in the Playlist or has no audio there', async () => {
    const asker = await createMember();
    const running = await seedPlaylist(asker, 'Running', [
      { title: 'Night Drive' },
      { title: 'Soon', playable: false },
    ]);
    const elsewhere = await seedPlaylist(asker, 'Calm', [{ title: 'Low Tide' }]);

    const notIn = await act(
      asker,
      undefined,
      play({ kind: 'playlist', id: running.playlistId, trackId: elsewhere.trackIds[0] }),
    );
    expect(commands(notIn)).toEqual([]);
    expect(notIn.results[0]).toMatch(/^That Track is not in the Playlist "Running"\./);

    const noAudio = await act(
      asker,
      undefined,
      play({ kind: 'playlist', id: running.playlistId, trackId: running.trackIds[1] }),
    );
    expect(commands(noAudio)).toEqual([]);
    expect(noAudio.results[0]).toMatch(/^The Track "Soon" has no audio that can be played\./);
  });

  it("answers an unknown id, a text that is no id and another user's private Playlist alike", async () => {
    const asker = await createMember();
    const owner = await createMember();
    const theirs = await seedPlaylist(owner, 'Private', [{ title: 'Mine Alone' }]);

    for (const id of [UNKNOWN_ID, 'running', theirs.playlistId]) {
      const turn = await act(asker, undefined, play({ kind: 'playlist', id }));

      expect(commands(turn), id).toEqual([]);
      expect(turn.results[0], id).toBe('No Playlist with that id. The player was left as it is.');
    }
  });
});

describe.skipIf(skip)('the Assistant asked to resume a Session', () => {
  it('hands the player a stopped Session and changes nothing itself', async () => {
    const asker = await createMember();
    const focus = await seedSession(asker, 'Deep Focus', [{ title: 'Low Tide' }]);
    const repeat = await seedSession(asker, 'Old Tape', [{ title: 'Hiss' }], {
      sessionMode: 'repeat',
    });
    const before = await sessionRows();

    const turn = await act(
      asker,
      undefined,
      play({ kind: 'session', id: focus.sessionId }),
      play({ kind: 'session', id: repeat.sessionId }),
    );

    expect(commands(turn)).toEqual([
      { name: 'play', source: { kind: 'session', id: focus.sessionId, name: 'Deep Focus' } },
      { name: 'play', source: { kind: 'session', id: repeat.sessionId, name: 'Old Tape' } },
    ]);
    expect(turn.results[0]).toBe('Done: the player was told to play the Session "Deep Focus".');
    // No Session is created, resumed or switched to another mode on the server:
    // the browser's own Resume does that, with the New Music setting as it is.
    expect(await sessionRows()).toEqual(before);
    expect(before).toHaveLength(2);
  });

  it('continues the active Session: one the browser has not engaged, and one it has paused', async () => {
    const asker = await createMember();
    const active = await seedSession(asker, 'Morning', [{ title: 'First Light' }], {
      status: 'active',
    });
    const paused: AssistantPlayerState = {
      source: { kind: 'session', id: active.sessionId },
      trackId: active.trackIds[0]!,
      playing: false,
    };

    for (const player of [undefined, paused]) {
      const turn = await act(asker, player, play({ kind: 'session', id: active.sessionId }));

      expect(commands(turn)).toEqual([
        { name: 'play', source: { kind: 'session', id: active.sessionId, name: 'Morning' } },
      ]);
    }
  });

  it('sends nothing for the Session that is already playing', async () => {
    const asker = await createMember();
    const active = await seedSession(asker, 'Morning', [{ title: 'First Light' }], {
      status: 'active',
    });

    const turn = await act(
      asker,
      { source: { kind: 'session', id: active.sessionId }, trackId: null, playing: true },
      play({ kind: 'session', id: active.sessionId }),
    );

    expect(commands(turn)).toEqual([]);
    expect(turn.results[0]).toBe(
      'The Session "Morning" is already playing. The player was left as it is.',
    );
  });

  it('sends nothing for a Session that cannot be resumed: no Track to play and New Music off', async () => {
    const asker = await createMember();
    const spent = await seedSession(
      asker,
      'Worn Out',
      [{ title: 'Gone', status: 'rejected', dislikedAt: new Date() }],
      { sessionMode: 'repeat' },
    );

    const turn = await act(asker, undefined, play({ kind: 'session', id: spent.sessionId }));

    expect(commands(turn)).toEqual([]);
    expect(turn.results[0]).toMatch(
      /^The Session "Worn Out" cannot be resumed: it has no Track left to play, and its New Music is off\./,
    );
  });

  it('resumes a Session with no Track left when its New Music is on, as Resume does', async () => {
    const asker = await createMember();
    const fresh = await seedSession(asker, 'Blank Page', []);

    const turn = await act(asker, undefined, play({ kind: 'session', id: fresh.sessionId }));

    expect(commands(turn)).toMatchObject([{ name: 'play', source: { id: fresh.sessionId } }]);
  });

  it("answers an unknown id, a text that is no id, another user's Session and one being deleted alike", async () => {
    const asker = await createMember();
    const owner = await createMember();
    const theirs = await seedSession(owner, 'Private', [{ title: 'Mine Alone' }]);
    const deleting = await seedSession(asker, 'Leaving', [{ title: 'Last One' }]);
    await testDb.db
      .update(activitySessions)
      .set({ deleteRequestedAt: new Date() })
      .where(eq(activitySessions.id, deleting.sessionId));

    for (const id of [UNKNOWN_ID, 'focus', theirs.sessionId, deleting.sessionId]) {
      const turn = await act(asker, undefined, play({ kind: 'session', id }));

      expect(commands(turn), id).toEqual([]);
      expect(turn.results[0], id).toBe('No Session with that id. The player was left as it is.');
    }
  });

  it('starts at one Track of the Session when given its id', async () => {
    const asker = await createMember();
    const focus = await seedSession(asker, 'Deep Focus', [
      { title: 'Low Tide' },
      { title: 'Night Drive' },
    ]);

    const turn = await act(
      asker,
      undefined,
      play({ kind: 'session', id: focus.sessionId, trackId: focus.trackIds[1] }),
    );

    expect(commands(turn)).toEqual([
      {
        name: 'play',
        source: { kind: 'session', id: focus.sessionId, name: 'Deep Focus' },
        track: { id: focus.trackIds[1], name: 'Night Drive' },
      },
    ]);
    expect(turn.results[0]).toBe(
      'Done: the player was told to play the Track "Night Drive" in the Session "Deep Focus".',
    );
  });

  it('sends nothing for a Track of another Session', async () => {
    const asker = await createMember();
    const focus = await seedSession(asker, 'Deep Focus', [{ title: 'Low Tide' }]);
    const other = await seedSession(asker, 'Rainy Window', [{ title: 'Drizzle' }]);

    const turn = await act(
      asker,
      undefined,
      play({ kind: 'session', id: focus.sessionId, trackId: other.trackIds[0] }),
    );

    expect(commands(turn)).toEqual([]);
    expect(turn.results[0]).toMatch(/^The Track "Drizzle" is not in the Session "Deep Focus"\./);
  });
});

describe.skipIf(skip)('the Assistant asked to play one Track', () => {
  it('plays it through its Session, as its row in the Library does', async () => {
    const asker = await createMember();
    const focus = await seedSession(asker, 'Deep Focus', [
      { title: 'Low Tide' },
      { title: 'Night Drive' },
    ]);
    const before = await sessionRows();

    const turn = await act(asker, undefined, play({ kind: 'track', id: focus.trackIds[1] }));

    expect(commands(turn)).toEqual([
      {
        name: 'play',
        source: { kind: 'session', id: focus.sessionId, name: 'Deep Focus' },
        track: { id: focus.trackIds[1], name: 'Night Drive' },
      },
    ]);
    expect(await sessionRows()).toEqual(before);
  });

  it('plays the Track on the deck when it is paused, and sends nothing while it plays', async () => {
    const asker = await createMember();
    const focus = await seedSession(asker, 'Deep Focus', [{ title: 'Low Tide' }], {
      status: 'active',
    });
    const onDeck: AssistantPlayerState = {
      source: { kind: 'session', id: focus.sessionId },
      trackId: focus.trackIds[0]!,
      playing: false,
    };

    const paused = await act(asker, onDeck, play({ kind: 'track', id: focus.trackIds[0] }));
    expect(commands(paused)).toHaveLength(1);

    const playing = await act(
      asker,
      { ...onDeck, playing: true },
      play({ kind: 'track', id: focus.trackIds[0] }),
    );
    expect(commands(playing)).toEqual([]);
    expect(playing.results[0]).toBe(
      'The Track "Low Tide" is already playing. The player was left as it is.',
    );
  });

  it('sends nothing for a removed Track, and says it was removed', async () => {
    const asker = await createMember();
    const focus = await seedSession(asker, 'Deep Focus', [
      { title: 'Low Tide' },
      { title: 'Skipped It', status: 'rejected', dislikedAt: new Date() },
    ]);

    for (const input of [
      { kind: 'track', id: focus.trackIds[1] },
      { kind: 'session', id: focus.sessionId, trackId: focus.trackIds[1] },
    ]) {
      const turn = await act(asker, undefined, play(input));

      expect(commands(turn)).toEqual([]);
      expect(turn.results[0]).toBe(
        'The Track "Skipped It" was removed and cannot be played. The player was left as it is.',
      );
    }
  });

  it('sends nothing for a Track without audio or without its Session, and points to a Playlist', async () => {
    const asker = await createMember();
    const waiting = await seedSession(asker, 'Deep Focus', [{ title: 'Soon', playable: false }]);
    const orphaned = await seedSession(asker, 'Leaving', [{ title: 'Kept' }]);
    await testDb.db
      .update(activitySessions)
      .set({ deleteRequestedAt: new Date() })
      .where(eq(activitySessions.id, orphaned.sessionId));

    for (const [id, title] of [
      [waiting.trackIds[0], 'Soon'],
      [orphaned.trackIds[0], 'Kept'],
    ]) {
      const turn = await act(asker, undefined, play({ kind: 'track', id }));

      expect(commands(turn), title).toEqual([]);
      expect(turn.results[0], title).toMatch(
        new RegExp(`^The Track "${title}" cannot be started on its own.*Playlist`),
      );
    }
  });

  it("answers an unknown id, a text that is no id and another user's private Track alike", async () => {
    const asker = await createMember();
    const owner = await createMember();
    const theirs = await seedSession(owner, 'Private', [{ title: 'Mine Alone' }]);

    for (const id of [UNKNOWN_ID, 'night drive', theirs.trackIds[0]]) {
      const turn = await act(asker, undefined, play({ kind: 'track', id }));

      expect(commands(turn), id).toEqual([]);
      expect(turn.results[0], id).toBe('No Track with that id. The player was left as it is.');
    }
  });

  it('sends a Track another user shares in the Lounge to the Playlist it is shared in', async () => {
    const asker = await createMember();
    const owner = await createMember();
    const shared = await seedPlaylist(owner, 'Night Owls', [{ title: 'Moonlit' }]);
    await setPlaylistShared(testDb.db, {
      ownerUserId: owner,
      playlistId: shared.playlistId,
      audience: { kind: 'everyone' },
    });

    const alone = await act(asker, undefined, play({ kind: 'track', id: shared.trackIds[0] }));
    expect(commands(alone)).toEqual([]);
    expect(alone.results[0]).toMatch(/^The Track "Moonlit" is another user's.*Playlist/);

    const inPlaylist = await act(
      asker,
      undefined,
      play({ kind: 'playlist', id: shared.playlistId, trackId: shared.trackIds[0] }),
    );
    expect(commands(inPlaylist)).toMatchObject([
      { name: 'play', source: { foreign: true }, track: { name: 'Moonlit' } },
    ]);
  });
});

describe.skipIf(skip)('the Assistant asked to play, among other player commands', () => {
  it('counts a play command toward the two the player takes for one message', async () => {
    const asker = await createMember();
    const focus = await seedSession(asker, 'Deep Focus', [{ title: 'Low Tide' }]);
    const running = await seedPlaylist(asker, 'Running', [{ title: 'Night Drive' }]);

    const engaged: AssistantPlayerState = {
      source: { kind: 'playlist', id: running.playlistId },
      trackId: running.trackIds[0]!,
      playing: true,
    };

    const turn = await act(
      asker,
      engaged,
      play({ kind: 'session', id: focus.sessionId }),
      { name: 'sleepTimer', input: { minutes: 30 } },
      play({ kind: 'playlist', id: running.playlistId }),
    );

    // The stream carries commands as their tools finish, not as they were asked for.
    expect(commands(turn)).toHaveLength(2);
    expect(commands(turn)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'play',
          source: expect.objectContaining({ id: focus.sessionId }),
        }),
        { name: 'sleepTimer', minutes: 30 },
      ]),
    );
    expect(turn.results[2]).toMatch(/already given the player 2 commands.*not passed on/i);
  });

  it('continues the active Session when asked to continue with nothing engaged in the browser', async () => {
    const asker = await createMember();
    const active = await seedSession(asker, 'Morning', [{ title: 'First Light' }], {
      status: 'active',
    });

    const turn = await act(asker, undefined, {
      name: 'playerControl',
      input: { command: 'continue' },
    });

    expect(commands(turn)).toEqual([
      { name: 'play', source: { kind: 'session', id: active.sessionId, name: 'Morning' } },
    ]);
    expect(turn.results[0]).toBe('Done: the player was told to play the Session "Morning".');
  });

  it('has nothing to continue with nothing engaged and no active Session', async () => {
    const asker = await createMember();
    await seedSession(asker, 'Deep Focus', [{ title: 'Low Tide' }]);

    const turn = await act(asker, undefined, {
      name: 'playerControl',
      input: { command: 'continue' },
    });

    expect(commands(turn)).toEqual([]);
    expect(turn.results[0]).toMatch(/nothing engaged.*the player was left as it is/i);
  });
});
