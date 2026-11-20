// `proposeNewMusicOn`: prepares switching New Music on for the asking user's
// active Session, up to a duration or with no limit, and switches nothing.
// New Music on buys music, so the tool only hands the chat a card; the user's
// click on that card is what saves the choice, through the route the player's
// New Music control saves through. Switching it off buys nothing and is
// `newMusicOff`.

import { getActiveSession } from '@liedmotif/db';
import type { LlmTool } from '@liedmotif/providers';
import {
  isDurationTargetReached,
  proposeNewMusicOnInputSchema,
  targetDurationMinutesSchema,
  type ProposeNewMusicOnInput,
} from '@liedmotif/shared';
import { newMusicLimitNote } from './card-note';
import { quoted } from './music-names';
import { generationRefusal, NO_ACTIVE_SESSION, notOffered, proposed } from './proposal';
import { PROPOSE_NEW_MUSIC_ON_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';
import type { TurnActions } from './turn-actions';

const WHICH_CHOICE =
  'New Music is switched on up to a length, which is a whole number from 1 to 600 minutes, or no limit: one of the two. Ask the user which they want.';

export function createProposeNewMusicOnTool(
  asker: AssistantAsker,
  actions: TurnActions,
): LlmTool<ProposeNewMusicOnInput> {
  const { db, userId } = asker;
  return {
    name: PROPOSE_NEW_MUSIC_ON_TOOL_NAME,
    description:
      "Prepares switching New Music on for the user's active Session, so it generates new Tracks again, and shows the user a card for it: up to a length of music in minutes, or with no limit. Give one of the two. Switches nothing and spends nothing: it is saved only when the user confirms the card.",
    inputSchema: proposeNewMusicOnInputSchema,
    execute: ({ targetDurationMinutes: minutes, noLimit }) =>
      actions.take('proposed', async () => {
        const active = await getActiveSession(db, { ownerUserId: userId });
        if (!active) {
          return notOffered(`${NO_ACTIVE_SESSION} New Music belongs to an active Session.`);
        }
        const target = targetDurationMinutesSchema.safeParse(minutes);
        if ((minutes == null) === !noLimit || (!noLimit && !target.success)) {
          return notOffered(WHICH_CHOICE);
        }
        const card = {
          kind: 'newMusicOn',
          session: { id: active.id, name: active.title },
          targetDurationMinutes: target.success ? target.data : null,
        } as const;
        if (
          active.sessionMode === 'keep_going' &&
          active.targetDurationMinutes === card.targetDurationMinutes
        ) {
          return notOffered(
            `New Music is already on for the Session ${quoted(active.title)}, ${newMusicLimitNote(card.targetDurationMinutes)}.`,
          );
        }
        // Saved at or below what the Session holds, the target is met at once
        // and nothing generates.
        if (isDurationTargetReached(card.targetDurationMinutes, active.generatedDurationSeconds)) {
          const held = Math.floor((active.generatedDurationSeconds ?? 0) / 60);
          return notOffered(
            `The Session already holds ${held} minutes of music, so up to ${card.targetDurationMinutes} minutes generates nothing. Ask the user for a longer length or for no limit.`,
          );
        }
        const refusal = await generationRefusal(asker);
        return refusal ? notOffered(refusal) : proposed(card);
      }),
  };
}
