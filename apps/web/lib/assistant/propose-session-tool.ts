// `proposeSession`: prepares a new Session and starts nothing. Starting one
// buys music, so the tool only checks that the app's start route would take
// the request and that the budget allows it, and hands the chat a card. The
// user's click on that card is what calls the route.

import type { LlmTool } from '@liedmotif/providers';
import {
  MAX_USER_PROMPT_LENGTH,
  proposeSessionInputSchema,
  sessionCardStartRequest,
  startSessionRequestSchema,
  type AssistantCard,
  type ProposeSessionInput,
} from '@liedmotif/shared';
import {
  homeCoverChoices,
  NEW_SESSION_LENGTH_RULE,
  newSessionLength,
  notOffered,
  proposed,
} from './proposal';
import { PROPOSE_SESSION_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';
import type { TurnActions } from './turn-actions';

/** The start route's request without the client id, which only a browser has. */
const cardRequestSchema = startSessionRequestSchema.omit({ clientId: true });

const NO_DESCRIPTION = `A Session starts from a description of at most ${MAX_USER_PROMPT_LENGTH} characters. Ask the user what they want to hear.`;

export function createProposeSessionTool(
  asker: AssistantAsker,
  actions: TurnActions,
): LlmTool<ProposeSessionInput> {
  return {
    name: PROPOSE_SESSION_TOOL_NAME,
    description: `Prepares a new Session from a description and shows the user a card for it. Starts nothing and spends nothing: the Session starts only when the user confirms the card. Instrumental unless the user asked for vocals. ${NEW_SESSION_LENGTH_RULE}`,
    inputSchema: proposeSessionInputSchema,
    execute: ({ prompt, vocal, targetDurationMinutes, noLimit }) =>
      actions.take('proposed', async () => {
        const gate = await newSessionLength(asker, { targetDurationMinutes, noLimit });
        if ('refusal' in gate) return notOffered(gate.refusal);
        const card: Extract<AssistantCard, { kind: 'session' }> = {
          kind: 'session',
          prompt: prompt.trim(),
          vocal: vocal ? 'vocal' : 'instrumental',
          ...gate.length,
          ...(await homeCoverChoices(asker)),
        };
        // The gate already took the length, so only the description can fail here.
        return cardRequestSchema.safeParse(sessionCardStartRequest(card)).success
          ? proposed(card)
          : notOffered(NO_DESCRIPTION);
      }),
  };
}
