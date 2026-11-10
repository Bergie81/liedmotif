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
import { newSessionRefusal, notOffered, proposed } from './proposal';
import { PROPOSE_SESSION_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';
import type { TurnActions } from './turn-actions';

/** The start route's request without the client id, which only a browser has. */
const cardRequestSchema = startSessionRequestSchema.omit({ clientId: true });

const NO_DESCRIPTION = `A Session starts from a description of at most ${MAX_USER_PROMPT_LENGTH} characters. Ask the user what they want to hear.`;
const BAD_DURATION = 'Session duration must be a whole number from 1 to 600 minutes.';

export function createProposeSessionTool(
  asker: AssistantAsker,
  actions: TurnActions,
): LlmTool<ProposeSessionInput> {
  return {
    name: PROPOSE_SESSION_TOOL_NAME,
    description:
      'Prepares a new Session from a description and shows the user a card for it. Starts nothing and spends nothing: the Session starts only when the user confirms the card. Instrumental unless the user asked for vocals.',
    inputSchema: proposeSessionInputSchema,
    execute: ({ prompt, vocal, targetDurationMinutes }) =>
      actions.take('proposed', async () => {
        const card: AssistantCard = {
          kind: 'session',
          prompt: prompt.trim(),
          vocal: vocal ? 'vocal' : 'instrumental',
          ...(targetDurationMinutes != null && { targetDurationMinutes }),
        };
        const request = cardRequestSchema.safeParse(sessionCardStartRequest(card));
        if (!request.success) {
          const duration = request.error.issues.some(
            (issue) => issue.path[0] === 'targetDurationMinutes',
          );
          return notOffered(duration ? BAD_DURATION : NO_DESCRIPTION);
        }
        const refusal = await newSessionRefusal(asker);
        return refusal ? notOffered(refusal) : proposed(card);
      }),
  };
}
