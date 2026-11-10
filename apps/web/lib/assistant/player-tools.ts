// `playerControl` and `sleepTimer`: commands for the player. The player lives
// in the browser, so these tools do nothing themselves: they check the command
// against the player state the request carried and hand it to the browser,
// which runs it through the player's own actions. What comes of it there, the
// server never learns; the next request's conversation says.

import { getActiveSession } from '@liedmotif/db';
import type { LlmTool } from '@liedmotif/providers';
import {
  playerControlInputSchema,
  sleepTimerInputSchema,
  type AssistantPlayerCommand,
  type AssistantPlayerControl,
  type AssistantPlayerState,
  type PlayerControlInput,
  type SleepTimerInput,
} from '@liedmotif/shared';
import { SLEEP_TIMER_MAX_MINUTES, SLEEP_TIMER_MIN_MINUTES } from '@/components/player/sleep-timer';
import { playerCommandNote } from './player-command-note';
import { PLAYER_CONTROL_TOOL_NAME, SLEEP_TIMER_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';
import type { ActionOutcome, TurnActions } from './turn-actions';

/** The command goes to the browser's player. The model's line is worded like the record later turns read. */
export const handedOver = (command: AssistantPlayerCommand): ActionOutcome<'player'> => ({
  told: `Done: the player was told to ${playerCommandNote(command)}.`,
  action: { status: 'player', command },
});

/** No command is sent, and the model is told why. */
export const refused = (why: string): ActionOutcome<'player'> => ({
  told: `${why} The player was left as it is.`,
});

const NOTHING_ENGAGED =
  'The player has nothing engaged in this browser, so there is nothing to control.';
const NO_TRACK = 'The player has no Track ready yet.';

/** Why `command` makes no sense for the player as the request described it, or null when it does. */
function pointless(command: AssistantPlayerControl, player: AssistantPlayerState): string | null {
  switch (command) {
    case 'pause':
      return player.playing ? null : 'The music is not playing.';
    case 'continue':
      return player.playing ? 'The music is already playing.' : null;
    case 'next':
    case 'previous':
    case 'restart':
      return player.trackId ? null : NO_TRACK;
    case 'endSession':
      return player.source.kind === 'playlist'
        ? 'A Playlist is not a Session and has nothing to end. Use pause to halt the music.'
        : null;
    case 'loopOn':
    case 'loopOff':
      return null;
  }
}

/**
 * "Continue" with nothing engaged: a freshly loaded page has no player yet,
 * but its mini player offers the active Session, and that is what plays on.
 */
async function continueActiveSession({ db, userId }: AssistantAsker) {
  const active = await getActiveSession(db, { ownerUserId: userId });
  return active
    ? handedOver({
        name: 'play',
        source: { kind: 'session', id: active.id, name: active.title },
      })
    : refused(NOTHING_ENGAGED);
}

export function createPlayerControlTool(
  asker: AssistantAsker,
  actions: TurnActions,
): LlmTool<PlayerControlInput> {
  const { player } = asker;
  return {
    name: PLAYER_CONTROL_TOOL_NAME,
    description:
      "Controls the player in the user's browser, like its own buttons: pause, continue, next, previous, restart, loopOn, loopOff, endSession. It cannot Dislike or delete a Track, change the volume or seek.",
    inputSchema: playerControlInputSchema,
    execute: ({ command }) =>
      actions.take('player', async () => {
        if (!player) {
          return command === 'continue' ? continueActiveSession(asker) : refused(NOTHING_ENGAGED);
        }
        const why = pointless(command, player);
        return why ? refused(why) : handedOver({ name: command });
      }),
  };
}

const SLEEP_TIMER_RANGE = `The Sleep Timer takes whole minutes from ${SLEEP_TIMER_MIN_MINUTES} to ${SLEEP_TIMER_MAX_MINUTES}. Ask the user for a time in that range.`;

export function createSleepTimerTool(
  { player }: AssistantAsker,
  actions: TurnActions,
): LlmTool<SleepTimerInput> {
  return {
    name: SLEEP_TIMER_TOOL_NAME,
    description: `Sets the player's Sleep Timer: the music fades out and pauses after that many minutes, ${SLEEP_TIMER_MIN_MINUTES} to ${SLEEP_TIMER_MAX_MINUTES}. A running timer is replaced. With off it cancels the running timer.`,
    inputSchema: sleepTimerInputSchema,
    execute: ({ minutes, off }) =>
      actions.take('player', async () => {
        if (!player) return refused(NOTHING_ENGAGED);
        if ((minutes == null) === !off) return refused('Give either minutes or off, not both.');
        if (off) {
          const running = (player.sleepTimerEndsAt ?? 0) > Date.now();
          return running
            ? handedOver({ name: 'sleepTimerOff' })
            : refused('No Sleep Timer is running.');
        }
        if (
          minutes == null ||
          !Number.isInteger(minutes) ||
          minutes < SLEEP_TIMER_MIN_MINUTES ||
          minutes > SLEEP_TIMER_MAX_MINUTES
        ) {
          return refused(SLEEP_TIMER_RANGE);
        }
        return handedOver({ name: 'sleepTimer', minutes });
      }),
  };
}
