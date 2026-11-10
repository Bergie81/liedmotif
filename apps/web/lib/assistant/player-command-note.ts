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
      return 'repeat the current Track';
    case 'loopOff':
      return 'stop repeating the current Track';
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
