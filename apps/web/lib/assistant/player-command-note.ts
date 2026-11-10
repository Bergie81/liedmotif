// A player command as the model reads it: what the player was told to do. The
// tool that hands the command over answers with this wording, and the chat
// panel sends it back with the answer it happened in, so the model reads one
// wording of a command in the turn that gave it and in every later one. Plain
// text, safe to import from the browser.

import type { AssistantPlayCommand, AssistantPlayerCommand } from '@liedmotif/shared';
import { quoted } from './music-names';

/** What a play command starts, by kind and name; a Track is named with what it plays in. */
function played({ source, track }: AssistantPlayCommand): string {
  const where = `the ${source.kind === 'session' ? 'Session' : 'Playlist'} ${quoted(source.name)}`;
  return track ? `the Track ${quoted(track.name)} in ${where}` : where;
}

/** The command as the end of "the player was told to …". */
export function playerCommandNote(command: AssistantPlayerCommand): string {
  switch (command.name) {
    case 'pause':
      return 'pause the music';
    case 'continue':
      return 'play on';
    case 'next':
      return 'skip to the next Track';
    case 'previous':
      return 'go back to the previous Track';
    case 'restart':
      return 'play the current Track from its start';
    case 'loopOn':
      return 'loop the current Track';
    case 'loopOff':
      return 'stop looping the current Track';
    case 'stop':
      return 'stop the Session';
    case 'sleepTimer':
      return `fade out and pause the music in ${command.minutes} min`;
    case 'sleepTimerOff':
      return 'switch the Sleep Timer off';
    case 'play':
      return `play ${played(command)}`;
  }
}

/**
 * What came of a command in the browser: the player did it, the browser
 * refused to start the audio it called for, it could not be done at all, or
 * the user turned it down when the player asked whether to play it over a
 * Session that was starting.
 */
export type PlayerCommandOutcome = 'done' | 'blocked' | 'failed' | 'declined';

/**
 * What a later turn is told about a command: one line, in brackets. Without an
 * outcome the command is still on its way, and the line says what the tool said.
 */
export function playerCommandRecord(
  command: AssistantPlayerCommand,
  outcome?: PlayerCommandOutcome,
): string {
  const told = playerCommandNote(command);
  switch (outcome) {
    case 'blocked':
      return `[Not done by the app: the browser refused to start the audio when the player was told to ${told}. The user was shown a "Tap to play" button.]`;
    case 'failed':
      return `[Not done by the app: the player could not ${told}]`;
    case 'declined':
      return `[Not done by the app: the user kept the new Session that was starting, so the player did not ${told}]`;
    default:
      return `[Done by the app: the player was told to ${told}]`;
  }
}
