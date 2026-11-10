// A player command from the Assistant, in the browser. The server only checked
// the command; here it reaches the player through the actions the player's own
// buttons call, and here is the only place that learns what came of it: done,
// or turned down by a browser that would not start audio.

import type {
  AssistantAction,
  AssistantPlayCommand,
  AssistantPlayerCommand,
  AssistantPlayerState,
} from '@liedmotif/shared';
import type { PlaybackControllerApi } from '@/components/player/playback-controller-api';
import type { SleepTimerControl } from '@/components/player/sleep-timer';
import { trackCount } from '@/lib/assistant/music-names';
import type { PlayerCommandOutcome } from '@/lib/assistant/player-command-note';
import { sessionTitle, trackTitle } from './receipt';

/**
 * How far the app's own play flow took a play command: it engaged the music,
 * which then starts by itself, the user declined, or the flow refused.
 */
export type PlayStart = 'started' | Extract<PlayerCommandOutcome, 'declined' | 'failed'>;

/** A player command as the chat holds it. Without an outcome it is still on its way. */
export type PlayerChatAction = Extract<AssistantAction, { status: 'player' }> & {
  outcome?: PlayerCommandOutcome;
};

/** The part of the live playback controller a command reaches or reads. */
export type CommandedController = Pick<
  PlaybackControllerApi,
  | 'status'
  | 'playIntentPending'
  | 'playbackMode'
  | 'deckARef'
  | 'deckBRef'
  | 'play'
  | 'pause'
  | 'skip'
  | 'previous'
  | 'restart'
  | 'setPlaybackMode'
>;

/** The player as a command finds it, read anew at every step: a command outlives the render it arrived in. */
export interface CommandedPlayer {
  /** The controller of the engaged source; null while nothing is engaged. */
  controller: () => CommandedController | null;
  /** What that controller plays, as every message reports it. */
  engaged: () => AssistantPlayerState | undefined;
  /** Hands a play command to the app's own play flow for what it names. */
  start: (play: AssistantPlayCommand) => Promise<PlayStart>;
  sleepTimer: Pick<SleepTimerControl, 'start' | 'cancel'>;
  /** The player's Stop Session for the engaged Session. False when nothing was stopped. */
  stopSession: () => Promise<boolean>;
}

/** What the app shell offers the chat panel for player commands. */
export interface PlayerCommands {
  /** Unlocks audio; called inside the gesture that sends a message. */
  prime: () => void;
  run: (command: AssistantPlayerCommand) => Promise<PlayerCommandOutcome>;
  /** Starts what a blocked command left on the deck; called inside the tap. */
  tapToPlay: () => Promise<PlayerCommandOutcome>;
}

const START_CHECK_MS = 250;
/** A player still waiting after this long waits for a Track, not for the browser. */
const START_GIVE_UP_MS = 15_000;

/**
 * A start the browser turned down leaves the player idle: the controller took
 * its play intent back, and neither deck is running. A deck the browser let
 * start is unpaused from the moment `play()` was called, however long it loads.
 */
function startRefused(controller: CommandedController): boolean {
  const idle = controller.status === 'ready' || controller.status === 'paused';
  const decksPaused = [controller.deckARef, controller.deckBRef].every(
    (deck) => deck.current?.paused ?? true,
  );
  return idle && !controller.playIntentPending && decksPaused;
}

/**
 * Whether the player has what `play` names: the Track on its deck when it
 * names one, wherever that Track plays, and the Session or Playlist otherwise.
 */
function plays(engaged: AssistantPlayerState | undefined, { source, track }: AssistantPlayCommand) {
  if (!engaged) return false;
  return track ? engaged.trackId === track.id : engaged.source.id === source.id;
}

/**
 * What became of a start the player was just asked for. Read on a later tick,
 * never at once: the controller's state and a rejected play promise both land
 * after the call that caused them. With `play` the start is that of music the
 * app is only now engaging, so the player is read once it has it; music that
 * never took over the player was not started.
 */
async function audioStarted(
  player: CommandedPlayer,
  play?: AssistantPlayCommand,
): Promise<PlayerCommandOutcome> {
  const arrived = () => !play || plays(player.engaged(), play);
  for (let waited = 0; waited < START_GIVE_UP_MS; waited += START_CHECK_MS) {
    await new Promise((resolve) => setTimeout(resolve, START_CHECK_MS));
    const controller = arrived() ? player.controller() : null;
    if (controller?.status === 'playing') return 'done';
    if (controller && startRefused(controller)) return 'blocked';
  }
  return arrived() ? 'done' : 'failed';
}

/** Runs `command` in the player and resolves with what came of it. */
export async function runPlayerCommand(
  command: AssistantPlayerCommand,
  player: CommandedPlayer,
): Promise<PlayerCommandOutcome> {
  if (command.name === 'play') {
    const start = await player.start(command);
    return start === 'started' ? audioStarted(player, command) : start;
  }
  const controller = player.controller();
  if (!controller) return 'failed';
  switch (command.name) {
    case 'pause':
      controller.pause();
      return 'done';
    case 'loopOn':
      controller.setPlaybackMode('loop-track');
      return 'done';
    case 'loopOff':
      // Only a loop is switched off: Shuffle is not this command's to end.
      if (controller.playbackMode === 'loop-track') controller.setPlaybackMode('loop-session');
      return 'done';
    case 'endSession':
      return (await player.stopSession()) ? 'done' : 'failed';
    case 'sleepTimer':
      player.sleepTimer.start(command.minutes);
      return 'done';
    case 'sleepTimerOff':
      player.sleepTimer.cancel();
      return 'done';
    case 'continue':
      controller.play();
      break;
    case 'next':
      controller.skip();
      break;
    case 'previous':
      controller.previous();
      break;
    case 'restart':
      controller.restart();
      break;
  }
  return audioStarted(player);
}

/**
 * "Tap to play": starts what is on the deck. A blocked command has already
 * moved the player where it should be, so only the start is left to do, and
 * `play` is called before anything is awaited, while the tap still counts.
 */
export function tapToPlay(player: CommandedPlayer): Promise<PlayerCommandOutcome> {
  const controller = player.controller();
  if (!controller) return Promise.resolve('failed');
  controller.play();
  return audioStarted(player);
}

/** What a play command plays, as the app names it: a Playlist with its size, a Track with where it plays. */
function playing({ source, track }: AssistantPlayCommand): string {
  const where = source.kind === 'session' ? sessionTitle(source) : source.name;
  if (track) return `${trackTitle(track)} · ${where}`;
  return source.kind === 'playlist' ? `${where} · ${trackCount(source.trackCount)}` : where;
}

function happened(command: AssistantPlayerCommand): string {
  switch (command.name) {
    case 'play':
      return `Playing: ${playing(command)}`;
    case 'pause':
      return 'Paused';
    case 'continue':
      return 'Playing';
    case 'next':
      return 'Skipped to the next Track';
    case 'previous':
      return 'Back to the previous Track';
    case 'restart':
      return 'Playing the Track from its start';
    case 'loopOn':
      return 'Loop Track on';
    case 'loopOff':
      return 'Loop Track off';
    case 'endSession':
      return 'Session stopped';
    case 'sleepTimer':
      return `Sleep Timer set: ${command.minutes} min`;
    case 'sleepTimerOff':
      return 'Sleep Timer off';
  }
}

/** The chat's line for a command, in the app's words, and whether it offers "Tap to play". */
export function playerCommandLine(
  command: AssistantPlayerCommand,
  outcome: PlayerCommandOutcome | undefined,
): { text: string; tapToPlay: boolean } {
  switch (outcome) {
    case 'blocked':
      return { text: 'Your browser did not start the audio.', tapToPlay: true };
    case 'failed':
      return { text: 'The player could not do that.', tapToPlay: false };
    case 'declined':
      return { text: 'Not played: you kept your new Session starting.', tapToPlay: false };
    default:
      return { text: happened(command), tapToPlay: false };
  }
}
