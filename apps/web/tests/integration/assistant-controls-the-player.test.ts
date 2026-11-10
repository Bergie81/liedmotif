// What the Assistant hands to the browser's player when its model calls a
// player tool: the command as an event of the reply stream, or a reason and no
// event when the command makes no sense for the player state the request
// carried. The route and the tools run for real; a scripted model stands in
// for the text LLM. The player itself lives in the browser and is not here.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { user, userProfiles } from '@liedmotif/db';
import {
  connectTestDb,
  createSession,
  GENERATION_FIXTURE_TABLES,
  seedSessionTrack,
  TEST_DATABASE_URL,
  truncateTables,
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
  getTypicalTracksPerMusicRequest: () => 2,
}));

const { POST } = await import('@/app/api/assistant/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

const SESSION = { kind: 'session', id: '7b0a1c5e-3f0d-4a55-9d0e-2f6f3f1f8a11' } as const;
const PLAYLIST = { kind: 'playlist', id: '0c9d4b7a-8a41-4b0e-b1a3-5a2d9d6c7e22' } as const;
const TRACK_ID = '5e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b';

/** A Session with a Track on the deck, audible. */
const PLAYING: AssistantPlayerState = { source: SESSION, trackId: TRACK_ID, playing: true };
const PAUSED: AssistantPlayerState = { ...PLAYING, playing: false };

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

const control = (command: string) => ({ name: 'playerControl', input: { command } });
const sleepTimer = (input: unknown) => ({ name: 'sleepTimer', input });

/** The commands a reply stream handed to the player, in order. */
const commands = ({ events }: ToolCallsTurn): AssistantPlayerCommand[] =>
  events.flatMap((event) =>
    event.type === 'action' && event.action.status === 'player' ? [event.action.command] : [],
  );

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('assistant-controls-the-player-test');
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

describe.skipIf(skip)('the Assistant asked to control the player', () => {
  it('hands each transport command to the player and tells the model what it was told', async () => {
    const asker = await createMember();
    const told: Record<string, RegExp> = {
      pause: /^Done: the player was told to pause the music\.$/,
      next: /^Done: the player was told to skip to the next Track\.$/,
      previous: /^Done: the player was told to go back to the previous Track\.$/,
      restart: /^Done: the player was told to play the current Track from its start\.$/,
      loopOn: /^Done: the player was told to loop the current Track\.$/,
      loopOff: /^Done: the player was told to stop looping the current Track\.$/,
      endSession: /^Done: the player was told to end the Session\.$/,
    };

    for (const [command, expected] of Object.entries(told)) {
      const turn = await act(asker, PLAYING, control(command));

      expect(commands(turn), command).toEqual([{ name: command }]);
      expect(turn.results[0], command).toMatch(expected);
      expect(turn.events.at(-1)).toEqual({ type: 'done' });
    }
  });

  it('continues music that is paused, and music that is engaged and has not played yet', async () => {
    const asker = await createMember();

    for (const player of [PAUSED, { ...PAUSED, trackId: null }]) {
      const turn = await act(asker, player, control('continue'));

      expect(commands(turn)).toEqual([{ name: 'continue' }]);
      expect(turn.results[0]).toBe('Done: the player was told to play on.');
    }
  });

  it('refuses every command while the player has nothing engaged, and sends none', async () => {
    const asker = await createMember();

    for (const command of ['pause', 'continue', 'next', 'loopOn', 'endSession']) {
      const turn = await act(asker, undefined, control(command));

      expect(commands(turn), command).toEqual([]);
      expect(turn.results[0], command).toMatch(/nothing engaged.*the player was left as it is/i);
    }
  });

  it('refuses a command the player state makes pointless, and says why', async () => {
    const asker = await createMember();
    const refusals: [AssistantPlayerState, string, RegExp][] = [
      [PAUSED, 'pause', /not playing/i],
      [PLAYING, 'continue', /already playing/i],
      [{ ...PAUSED, trackId: null }, 'next', /no Track ready/i],
      [{ ...PAUSED, trackId: null }, 'previous', /no Track ready/i],
      [{ ...PAUSED, trackId: null }, 'restart', /no Track ready/i],
      [{ ...PLAYING, source: PLAYLIST }, 'endSession', /Playlist is not a Session.*pause/i],
    ];

    for (const [player, command, why] of refusals) {
      const turn = await act(asker, player, control(command));

      expect(commands(turn), command).toEqual([]);
      expect(turn.results[0], command).toMatch(why);
      expect(turn.results[0], command).toMatch(/the player was left as it is\.$/i);
    }
  });

  it('controls a playing Playlist like a Session', async () => {
    const asker = await createMember();

    const turn = await act(
      asker,
      { ...PLAYING, source: PLAYLIST },
      control('next'),
      control('loopOn'),
    );

    expect(commands(turn)).toEqual([{ name: 'next' }, { name: 'loopOn' }]);
  });

  it('passes on two commands for one message and refuses the third', async () => {
    const asker = await createMember();

    const turn = await act(asker, PLAYING, control('next'), control('loopOn'), control('pause'));

    expect(commands(turn)).toEqual([{ name: 'next' }, { name: 'loopOn' }]);
    expect(turn.results[2]).toMatch(/already given the player 2 commands.*not passed on/i);
  });
});

describe.skipIf(skip)('the Assistant asked for the Sleep Timer', () => {
  it('sets it for the minutes asked, on a Session and on a Playlist, playing or paused', async () => {
    const asker = await createMember();

    for (const player of [PLAYING, PAUSED, { ...PLAYING, source: PLAYLIST }]) {
      const turn = await act(asker, player, sleepTimer({ minutes: 30 }));

      expect(commands(turn)).toEqual([{ name: 'sleepTimer', minutes: 30 }]);
      expect(turn.results[0]).toBe(
        'Done: the player was told to fade out and pause the music in 30 min.',
      );
    }
  });

  it('replaces a running timer', async () => {
    const asker = await createMember();
    const running = { ...PLAYING, sleepTimerEndsAt: Date.now() + 10 * 60_000 };

    const turn = await act(asker, running, sleepTimer({ minutes: 45 }));

    expect(commands(turn)).toEqual([{ name: 'sleepTimer', minutes: 45 }]);
  });

  it('takes 5 to 90 whole minutes, and tells the model so instead of rounding', async () => {
    const asker = await createMember();

    for (const minutes of [5, 90]) {
      const turn = await act(asker, PLAYING, sleepTimer({ minutes }));
      expect(commands(turn), String(minutes)).toEqual([{ name: 'sleepTimer', minutes }]);
    }
    for (const minutes of [4, 91, 120, 0, -30, 12.5]) {
      const turn = await act(asker, PLAYING, sleepTimer({ minutes }));

      expect(commands(turn), String(minutes)).toEqual([]);
      expect(turn.results[0], String(minutes)).toMatch(
        /whole minutes from 5 to 90.*the player was left as it is/i,
      );
    }
  });

  it('cancels a running timer', async () => {
    const asker = await createMember();
    const running = { ...PLAYING, sleepTimerEndsAt: Date.now() + 10 * 60_000 };

    const turn = await act(asker, running, sleepTimer({ off: true }));

    expect(commands(turn)).toEqual([{ name: 'sleepTimerOff' }]);
    expect(turn.results[0]).toBe('Done: the player was told to switch the Sleep Timer off.');
  });

  it('refuses to cancel when no timer runs, or the one it was told of has run out', async () => {
    const asker = await createMember();

    for (const player of [PLAYING, { ...PLAYING, sleepTimerEndsAt: Date.now() - 1000 }]) {
      const turn = await act(asker, player, sleepTimer({ off: true }));

      expect(commands(turn)).toEqual([]);
      expect(turn.results[0]).toMatch(/no Sleep Timer is running/i);
    }
  });

  it('refuses while the player has nothing engaged, and a call that asks for both or neither', async () => {
    const asker = await createMember();

    const nothingEngaged = await act(asker, undefined, sleepTimer({ minutes: 30 }));
    expect(commands(nothingEngaged)).toEqual([]);
    expect(nothingEngaged.results[0]).toMatch(/nothing engaged/i);

    for (const input of [{}, { minutes: 30, off: true }, { off: false }]) {
      const turn = await act(asker, PLAYING, sleepTimer(input));

      expect(commands(turn)).toEqual([]);
      expect(turn.results[0]).toMatch(/either minutes or off/i);
    }
  });

  it('shares the two player commands of a message with the transport', async () => {
    const asker = await createMember();

    const turn = await act(
      asker,
      PLAYING,
      control('next'),
      sleepTimer({ minutes: 30 }),
      control('loopOn'),
    );

    expect(commands(turn)).toEqual([{ name: 'next' }, { name: 'sleepTimer', minutes: 30 }]);
  });
});

describe.skipIf(skip)('the Assistant asked how long the Sleep Timer has left', () => {
  /** A Session of `asker`'s with one Track, as the player would have it engaged. */
  async function engaged(asker: string): Promise<AssistantPlayerState> {
    const sessionId = await createSession(testDb.db, { ownerUserId: asker });
    const trackId = await seedSessionTrack(testDb.db, asker, sessionId, { title: 'Night Drive' });
    return { source: { kind: 'session', id: sessionId }, trackId, playing: true };
  }

  it('reads it from the player state, in whole minutes', async () => {
    const asker = await createMember();
    const player = await engaged(asker);

    const turn = await act(
      asker,
      { ...player, sleepTimerEndsAt: Date.now() + 12 * 60_000 - 5000 },
      { name: 'nowPlaying', input: {} },
    );

    expect(turn.results[0]).toContain('Sleep Timer: the music pauses in 12 min');
  });

  it('says the timer is off when none runs', async () => {
    const asker = await createMember();

    const turn = await act(asker, await engaged(asker), { name: 'nowPlaying', input: {} });

    expect(turn.results[0]).toContain('Sleep Timer: off');
  });
});
