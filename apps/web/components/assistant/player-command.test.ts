// A player command the Assistant handed over, in the browser: which of the
// player's own actions it reaches, what is made of a browser that refuses to
// start audio, how the chat words it, and what the next request is told.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AssistantPlayCommand,
  AssistantPlayerCommand,
  AssistantPlayerState,
} from '@liedmotif/shared';
import {
  playerCommandLine,
  playerCommandRecord,
  runPlayerCommand,
  tapToPlay,
  type CommandedController,
  type CommandedPlayer,
} from './player-command';

type Deck = { current: { paused: boolean } | null };

/** A controller as a command finds it: every action a spy, the state plain values a test moves. */
function controllerIn(status: CommandedController['status']) {
  const decks = {
    a: { current: { paused: true } } as Deck,
    b: { current: { paused: true } } as Deck,
  };
  const controller = {
    status,
    playIntentPending: false,
    playbackMode: 'loop-session' as CommandedController['playbackMode'],
    deckARef: decks.a as CommandedController['deckARef'],
    deckBRef: decks.b as CommandedController['deckBRef'],
    play: vi.fn(),
    pause: vi.fn(),
    skip: vi.fn(),
    previous: vi.fn(),
    restart: vi.fn(),
    setPlaybackMode: vi.fn(),
  };
  return {
    controller,
    /** The browser let a deck start: audio is on its way. */
    deckStarts: () => {
      decks.a.current!.paused = false;
    },
  };
}

function playerWith(controller: CommandedController | null) {
  const sleepTimer = { start: vi.fn(), cancel: vi.fn() };
  const stopSession = vi.fn(async () => true);
  const start = vi.fn<CommandedPlayer['start']>(async () => 'started');
  /** What the player has engaged; a test moves it as a play flow would. */
  const now: { controller: CommandedController | null; engaged?: AssistantPlayerState } = {
    controller,
  };
  const player: CommandedPlayer = {
    controller: () => now.controller,
    engaged: () => now.engaged,
    sleepTimer,
    stopSession,
    start,
  };
  return { player, sleepTimer, stopSession, start, now };
}

const named = (name: Exclude<AssistantPlayerCommand['name'], 'sleepTimer' | 'play'>) =>
  ({ name }) as AssistantPlayerCommand;

const RUNNING_ID = '0c9d4b7a-8a41-4b0e-b1a3-5a2d9d6c7e22';
const FOCUS_ID = '7b0a1c5e-3f0d-4a55-9d0e-2f6f3f1f8a11';
const TRACK_ID = '5e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b';

const RUNNING = { kind: 'playlist', id: RUNNING_ID, name: 'Running', foreign: false } as const;
const PLAY_RUNNING: AssistantPlayCommand = {
  name: 'play',
  source: { ...RUNNING, trackCount: 24 },
};
const PLAY_FOCUS: AssistantPlayCommand = {
  name: 'play',
  source: { kind: 'session', id: FOCUS_ID, name: 'Deep Focus' },
};
const PLAY_TRACK: AssistantPlayCommand = {
  ...PLAY_FOCUS,
  track: { id: TRACK_ID, name: 'Night Drive' },
};

/** The player with `id` engaged and `trackId` on its deck. */
const engagedOn = (kind: 'session' | 'playlist', id: string, trackId: string | null = null) =>
  ({ source: { kind, id }, trackId, playing: false }) satisfies AssistantPlayerState;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a player command from the Assistant', () => {
  it('pauses through the player’s own pause', async () => {
    const { controller } = controllerIn('playing');
    const { player } = playerWith(controller);

    expect(await runPlayerCommand(named('pause'), player)).toBe('done');
    expect(controller.pause).toHaveBeenCalledOnce();
  });

  it.each([
    ['continue', 'play'],
    ['next', 'skip'],
    ['previous', 'previous'],
    ['restart', 'restart'],
  ] as const)('runs "%s" through the player’s own %s', async (name, action) => {
    const { controller } = controllerIn('playing');
    const { player } = playerWith(controller);

    const outcome = runPlayerCommand(named(name), player);
    await vi.runAllTimersAsync();

    expect(await outcome).toBe('done');
    expect(controller[action]).toHaveBeenCalledOnce();
    for (const other of ['play', 'skip', 'previous', 'restart', 'pause'] as const) {
      if (other !== action) expect(controller[other]).not.toHaveBeenCalled();
    }
  });

  it('switches Loop Track on, and off again to the mode a source starts in', async () => {
    const { controller } = controllerIn('playing');
    const { player } = playerWith(controller);

    expect(await runPlayerCommand(named('loopOn'), player)).toBe('done');
    expect(controller.setPlaybackMode).toHaveBeenLastCalledWith('loop-track');

    controller.playbackMode = 'loop-track';
    expect(await runPlayerCommand(named('loopOff'), player)).toBe('done');
    expect(controller.setPlaybackMode).toHaveBeenLastCalledWith('loop-session');
  });

  it('leaves Shuffle alone when asked to stop a loop that is not on', async () => {
    const { controller } = controllerIn('playing');
    controller.playbackMode = 'shuffle';
    const { player } = playerWith(controller);

    expect(await runPlayerCommand(named('loopOff'), player)).toBe('done');
    expect(controller.setPlaybackMode).not.toHaveBeenCalled();
  });

  it('stops through the player’s Stop Session, and says so when that fails', async () => {
    const { controller } = controllerIn('playing');
    const { player, stopSession } = playerWith(controller);

    expect(await runPlayerCommand(named('stop'), player)).toBe('done');
    expect(stopSession).toHaveBeenCalledOnce();

    stopSession.mockResolvedValueOnce(false);
    expect(await runPlayerCommand(named('stop'), player)).toBe('failed');
  });

  it('sets the player’s Sleep Timer and cancels it', async () => {
    const { controller } = controllerIn('paused');
    const { player, sleepTimer } = playerWith(controller);

    expect(await runPlayerCommand({ name: 'sleepTimer', minutes: 30 }, player)).toBe('done');
    expect(sleepTimer.start).toHaveBeenCalledExactlyOnceWith(30);

    expect(await runPlayerCommand(named('sleepTimerOff'), player)).toBe('done');
    expect(sleepTimer.cancel).toHaveBeenCalledOnce();
  });

  it('fails, and touches nothing, when the player has nothing engaged any more', async () => {
    const { player, sleepTimer, stopSession } = playerWith(null);

    for (const command of [named('pause'), named('continue'), named('stop')]) {
      expect(await runPlayerCommand(command, player)).toBe('failed');
    }
    expect(await runPlayerCommand({ name: 'sleepTimer', minutes: 30 }, player)).toBe('failed');
    expect(sleepTimer.start).not.toHaveBeenCalled();
    expect(stopSession).not.toHaveBeenCalled();
  });
});

describe('a command that starts audio', () => {
  it('is done once the player is audible', async () => {
    const { controller, deckStarts } = controllerIn('paused');
    controller.play.mockImplementation(() => {
      controller.playIntentPending = true;
      deckStarts();
    });
    const { player } = playerWith(controller);
    let outcome: string | null = null;

    void runPlayerCommand(named('continue'), player).then((came) => {
      outcome = came;
    });
    await vi.advanceTimersByTimeAsync(2000);
    // The source is still loading: neither audible nor turned down.
    expect(outcome).toBeNull();

    controller.status = 'playing';
    controller.playIntentPending = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(outcome).toBe('done');
  });

  it('is blocked when the browser turned the start down: no deck runs and no play intent is left', async () => {
    const { controller } = controllerIn('paused');
    // The play promise was rejected at once, and the controller took the intent back.
    controller.play.mockImplementation(() => {
      controller.playIntentPending = false;
    });
    const { player } = playerWith(controller);

    const outcome = runPlayerCommand(named('continue'), player);
    await vi.runAllTimersAsync();

    expect(await outcome).toBe('blocked');
  });

  it('is blocked when a skip from pause lands on a Track the browser would not start', async () => {
    const { controller } = controllerIn('paused');
    controller.skip.mockImplementation(() => {
      controller.status = 'ready';
    });
    const { player } = playerWith(controller);

    const outcome = runPlayerCommand(named('next'), player);
    await vi.runAllTimersAsync();

    expect(await outcome).toBe('blocked');
  });

  it('is not blocked while a deck the browser let start is still loading', async () => {
    const { controller, deckStarts } = controllerIn('paused');
    controller.skip.mockImplementation(deckStarts);
    const { player } = playerWith(controller);
    let outcome: string | null = null;

    void runPlayerCommand(named('next'), player).then((came) => {
      outcome = came;
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(outcome).toBeNull();

    controller.status = 'playing';
    await vi.advanceTimersByTimeAsync(500);
    expect(outcome).toBe('done');
  });

  it('is done when the player waits for a Track that is not there yet', async () => {
    const { controller } = controllerIn('playing');
    controller.skip.mockImplementation(() => {
      controller.status = 'waiting';
      controller.playIntentPending = true;
    });
    const { player } = playerWith(controller);

    const outcome = runPlayerCommand(named('next'), player);
    await vi.runAllTimersAsync();

    expect(await outcome).toBe('done');
  });
});

describe('a play command', () => {
  it('goes to the app’s own play flow with nothing engaged, and is done once that music is audible', async () => {
    const { player, start, now } = playerWith(null);
    let outcome: string | null = null;

    void runPlayerCommand(PLAY_RUNNING, player).then((came) => {
      outcome = came;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(start).toHaveBeenCalledExactlyOnceWith(PLAY_RUNNING);
    // The Playlist is still mounting: nothing is engaged yet.
    expect(outcome).toBeNull();

    now.controller = controllerIn('playing').controller;
    now.engaged = engagedOn('playlist', RUNNING_ID);
    await vi.advanceTimersByTimeAsync(500);
    expect(outcome).toBe('done');
  });

  it('is not done while the music it replaces still plays', async () => {
    const { player, now } = playerWith(controllerIn('playing').controller);
    now.engaged = engagedOn('session', FOCUS_ID);
    let outcome: string | null = null;

    void runPlayerCommand(PLAY_RUNNING, player).then((came) => {
      outcome = came;
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(outcome).toBeNull();

    now.engaged = engagedOn('playlist', RUNNING_ID);
    await vi.advanceTimersByTimeAsync(500);
    expect(outcome).toBe('done');
  });

  it('waits for the Track it names to be the one on the deck', async () => {
    const { player, now } = playerWith(controllerIn('playing').controller);
    now.engaged = engagedOn('session', FOCUS_ID, RUNNING_ID);
    let outcome: string | null = null;

    void runPlayerCommand(PLAY_TRACK, player).then((came) => {
      outcome = came;
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(outcome).toBeNull();

    now.engaged = engagedOn('session', FOCUS_ID, TRACK_ID);
    await vi.advanceTimersByTimeAsync(500);
    expect(outcome).toBe('done');
  });

  it('is blocked when the browser would not start the music the flow engaged', async () => {
    const { player, now } = playerWith(null);
    now.controller = controllerIn('ready').controller;
    now.engaged = engagedOn('session', FOCUS_ID);

    const outcome = runPlayerCommand(PLAY_FOCUS, player);
    await vi.runAllTimersAsync();

    expect(await outcome).toBe('blocked');
  });

  it('is done when its music is engaged and still waits for a Track, and failed when it never took over', async () => {
    const waiting = playerWith(null);
    waiting.now.controller = { ...controllerIn('waiting').controller, playIntentPending: true };
    waiting.now.engaged = engagedOn('session', FOCUS_ID);
    const resumed = runPlayerCommand(PLAY_FOCUS, waiting.player);

    const elsewhere = playerWith(controllerIn('waiting').controller);
    elsewhere.now.engaged = engagedOn('playlist', RUNNING_ID);
    const lost = runPlayerCommand(PLAY_FOCUS, elsewhere.player);
    await vi.runAllTimersAsync();

    expect(await resumed).toBe('done');
    expect(await lost).toBe('failed');
  });

  it.each(['declined', 'failed'] as const)(
    'is %s when the play flow says so, and waits for no audio',
    async (said) => {
      const { player, start } = playerWith(controllerIn('playing').controller);
      start.mockResolvedValue(said);

      expect(await runPlayerCommand(PLAY_RUNNING, player)).toBe(said);
    },
  );
});

describe('"Tap to play"', () => {
  it('starts what is on the deck through the player’s own play, inside the tap', async () => {
    const { controller, deckStarts } = controllerIn('ready');
    controller.play.mockImplementation(() => {
      deckStarts();
      controller.status = 'playing';
    });
    const { player } = playerWith(controller);

    const outcome = tapToPlay(player);
    // Called before anything is awaited: the tap's activation is still live.
    expect(controller.play).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();

    expect(await outcome).toBe('done');
    expect(controller.skip).not.toHaveBeenCalled();
  });

  it('stays blocked when even the tap did not start audio, and fails with nothing engaged', async () => {
    const { controller } = controllerIn('ready');
    const { player } = playerWith(controller);

    const outcome = tapToPlay(player);
    await vi.runAllTimersAsync();
    expect(await outcome).toBe('blocked');

    expect(await tapToPlay(playerWith(null).player)).toBe('failed');
  });
});

describe('the line a player command gets in the chat', () => {
  it('says what happened, in the app’s words', () => {
    const said = (command: AssistantPlayerCommand) => playerCommandLine(command, 'done').text;

    expect(said(named('pause'))).toBe('Paused');
    expect(said(named('continue'))).toBe('Playing');
    expect(said(named('next'))).toBe('Skipped to the next Track');
    expect(said(named('previous'))).toBe('Back to the previous Track');
    expect(said(named('restart'))).toBe('Playing the Track from its start');
    expect(said(named('loopOn'))).toBe('Loop Track on');
    expect(said(named('loopOff'))).toBe('Loop Track off');
    expect(said(named('stop'))).toBe('Session stopped');
    expect(said({ name: 'sleepTimer', minutes: 30 })).toBe('Sleep Timer set: 30 min');
    expect(said(named('sleepTimerOff'))).toBe('Sleep Timer off');
  });

  it('names what a play command plays: the Playlist with its size, the Session, or the Track with where it plays', () => {
    const said = (command: AssistantPlayerCommand) => playerCommandLine(command, 'done').text;

    expect(said(PLAY_RUNNING)).toBe('Playing: Running · 24 Tracks');
    expect(said(PLAY_FOCUS)).toBe('Playing: Deep Focus');
    expect(said(PLAY_TRACK)).toBe('Playing: Night Drive · Deep Focus');
    expect(said({ name: 'play', source: { kind: 'session', id: FOCUS_ID, name: null } })).toBe(
      'Playing: Untitled Session',
    );
    expect(
      said({
        name: 'play',
        source: { ...RUNNING, trackCount: 1 },
        track: { id: TRACK_ID, name: null },
      }),
    ).toBe('Playing: Untitled Track · Running');
  });

  it('says a play command was left alone when the user kept the Session that was starting', () => {
    expect(playerCommandLine(PLAY_RUNNING, 'declined')).toEqual({
      text: 'Not played: you kept your new Session starting.',
      tapToPlay: false,
    });
  });

  it('offers "Tap to play" only when the browser refused to start audio', () => {
    expect(playerCommandLine(named('continue'), 'blocked')).toEqual({
      text: 'Your browser did not start the audio.',
      tapToPlay: true,
    });
    for (const outcome of ['done', 'failed', undefined] as const) {
      expect(playerCommandLine(named('continue'), outcome).tapToPlay).toBe(false);
    }
  });

  it('says a command that failed did not happen', () => {
    expect(playerCommandLine(named('stop'), 'failed').text).toBe('The player could not do that.');
  });

  it('words a command still on its way like one that is done', () => {
    expect(playerCommandLine(named('pause'), undefined).text).toBe('Paused');
  });
});

describe('what the next request is told about a player command', () => {
  const record = (outcome?: 'done' | 'blocked' | 'failed') =>
    playerCommandRecord({ status: 'player', command: named('continue'), outcome });

  it('is the command as the tool worded it, once it is done or still on its way', () => {
    expect(record('done')).toBe('[Done by the app: the player was told to play on]');
    expect(record()).toBe('[Done by the app: the player was told to play on]');
  });

  it('says the browser refused to start the audio, and what the user was shown', () => {
    expect(record('blocked')).toBe(
      '[Not done by the app: the browser refused to start the audio when the player was told to play on. The user was shown a "Tap to play" button.]',
    );
  });

  it('says the player could not do it', () => {
    expect(record('failed')).toBe('[Not done by the app: the player could not play on]');
  });

  it('names what a play command played, as the tool worded it', () => {
    expect(playerCommandRecord({ status: 'player', command: PLAY_TRACK, outcome: 'done' })).toBe(
      '[Done by the app: the player was told to play the Track "Night Drive" in the Session "Deep Focus"]',
    );
  });

  it('says the user chose the Session that was starting over a play command', () => {
    expect(
      playerCommandRecord({ status: 'player', command: PLAY_RUNNING, outcome: 'declined' }),
    ).toBe(
      '[Not done by the app: the user kept the new Session that was starting, so the player did not play the Playlist "Running"]',
    );
  });
});
