// `proposeChangeVibe`: prepares a Change Vibe for the asking user's active
// Session and changes nothing. A new vibe buys music, so the tool only checks
// what the Change Vibe route would refuse, and hands the chat a card. The
// user's click on that card is what calls the route.

import { getActiveSession } from '@liedmotif/db';
import type { LlmTool } from '@liedmotif/providers';
import {
  assistantCardSchema,
  DURATION_TARGET_REACHED_MESSAGE,
  isDurationTargetReached,
  MAX_USER_PROMPT_LENGTH,
  proposeChangeVibeInputSchema,
  type ProposeChangeVibeInput,
} from '@liedmotif/shared';
import { changeVibeRefusal, NO_ACTIVE_SESSION, notOffered, proposed } from './proposal';
import { PROPOSE_CHANGE_VIBE_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';
import type { TurnActions } from './turn-actions';

const NO_WORDS = `A Change Vibe needs what should change, in at most ${MAX_USER_PROMPT_LENGTH} characters. Ask the user what they want to hear.`;

export function createProposeChangeVibeTool(
  asker: AssistantAsker,
  actions: TurnActions,
): LlmTool<ProposeChangeVibeInput> {
  const { db, userId } = asker;
  return {
    name: PROPOSE_CHANGE_VIBE_TOOL_NAME,
    description:
      "Prepares a Change Vibe for the user's active Session and shows the user a card for it: the same Session goes on in a changed direction. Changes nothing and spends nothing: the vibe changes only when the user confirms the card.",
    inputSchema: proposeChangeVibeInputSchema,
    execute: ({ prompt }) =>
      actions.take('proposed', async () => {
        const active = await getActiveSession(db, { ownerUserId: userId });
        if (!active) {
          return notOffered(`${NO_ACTIVE_SESSION} Only an active Session has a vibe to change.`);
        }
        const card = assistantCardSchema.safeParse({
          kind: 'changeVibe',
          session: { id: active.id, name: active.title },
          prompt: prompt.trim(),
        });
        if (!card.success) return notOffered(NO_WORDS);
        // The route's own refusals, in its order: the pause, the budget, then the target.
        const refusal = await changeVibeRefusal(asker);
        if (refusal) return notOffered(refusal);
        if (
          isDurationTargetReached(active.targetDurationMinutes, active.generatedDurationSeconds)
        ) {
          return notOffered(DURATION_TARGET_REACHED_MESSAGE);
        }
        return proposed(card.data);
      }),
  };
}
