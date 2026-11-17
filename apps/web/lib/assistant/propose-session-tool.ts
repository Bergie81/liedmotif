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
import { startingSessionMode } from '@/lib/sessions';
import { BAD_DURATION, newSessionRefusal, notOffered, proposed } from './proposal';
import { PROPOSE_SESSION_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';
import type { TurnActions } from './turn-actions';

/** The start route's request without the client id, which only a browser has. */
const cardRequestSchema = startSessionRequestSchema.omit({ clientId: true });

const NO_DESCRIPTION = `A Session starts from a description of at most ${MAX_USER_PROMPT_LENGTH} characters. Ask the user what they want to hear.`;
const HOW_LONG =
  'A new Session keeps generating new Tracks while the user listens, so it needs a length, which is a whole number from 1 to 600 minutes, or no limit. Ask the user how long it should run.';
const NO_LIMIT_ON_REPEAT =
  "This user's new Sessions start with New music off: a new Session generates its first Tracks and then repeats them, so it cannot start with no limit. Offer a length in minutes, or to start it without one and switch New music on afterwards.";

export function createProposeSessionTool(
  asker: AssistantAsker,
  actions: TurnActions,
): LlmTool<ProposeSessionInput> {
  return {
    name: PROPOSE_SESSION_TOOL_NAME,
    description:
      'Prepares a new Session from a description and shows the user a card for it. Starts nothing and spends nothing: the Session starts only when the user confirms the card. Instrumental unless the user asked for vocals. Runs for a length in minutes, or with no limit: give the one the user named, and neither when they named none.',
    inputSchema: proposeSessionInputSchema,
    execute: ({ prompt, vocal, targetDurationMinutes, noLimit }) =>
      actions.take('proposed', async () => {
        const card: Extract<AssistantCard, { kind: 'session' }> = {
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
        if (refusal) return notOffered(refusal);
        if (targetDurationMinutes != null) return proposed(card);
        // A Session that starts on Keep Going without a target buys music for
        // as long as it is listened to: that is the user's to say, never a
        // default. One that starts on Repeat stops after its first batch,
        // which is not what "no limit" asks for.
        const keepsGoing = (await startingSessionMode(asker.db, asker.userId)) === 'keep_going';
        if (noLimit) {
          return keepsGoing
            ? proposed({ ...card, targetDurationMinutes: null })
            : notOffered(NO_LIMIT_ON_REPEAT);
        }
        return keepsGoing ? notOffered(HOW_LONG) : proposed(card);
      }),
  };
}
