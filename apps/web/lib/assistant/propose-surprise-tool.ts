// `proposeSurprise`: prepares a Surprise Me suggestion the way Home's Surprise
// Me does, and starts nothing. Preparing one is the app's own propose
// function, run as the asker: its gates, the same Text AI calls the app's
// own Surprise Me button makes, and its pending suggestion, which Home then
// shows too. Starting it buys music, so the chat gets a card, and only the
// user's click on that card reaches the start route.

import type { LlmTool } from '@liedmotif/providers';
import {
  isSungTheme,
  proposeSurpriseInputSchema,
  targetDurationMinutesSchema,
  type AssistantCard,
  type ProposeSurpriseInput,
} from '@liedmotif/shared';
import { loadPendingSurprise, proposeSurprise } from '@/lib/sessions/surprise-me';
import { BAD_DURATION, homeCoverChoices, notOffered, proposed } from './proposal';
import { PROPOSE_SURPRISE_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';
import type { TurnActions } from './turn-actions';

const BUSY =
  'A Surprise Me suggestion is already being prepared for this user. Tell them to ask again in a moment.';
const RATE_LIMITED = 'Too many requests. Please slow down.';

export function createProposeSurpriseTool(
  asker: AssistantAsker,
  actions: TurnActions,
): LlmTool<ProposeSurpriseInput> {
  const { db, userId, signal } = asker;
  return {
    name: PROPOSE_SURPRISE_TOOL_NAME,
    description:
      "Prepares a Surprise Me suggestion from the user's own taste, as the app's Surprise Me does, and shows the user a card for it. Each call replaces the suggestion before it. Starts nothing and spends no music: the Session starts only when the user confirms the card. Pass only what the user asked for.",
    inputSchema: proposeSurpriseInputSchema,
    execute: ({ adventurous, theme, vocal, targetDurationMinutes, noLimit }) =>
      actions.take('proposed', async () => {
        if (
          targetDurationMinutes != null &&
          !targetDurationMinutesSchema.safeParse(targetDurationMinutes).success
        ) {
          return notOffered(BAD_DURATION);
        }

        // Read before the suggestion is replaced: a card that then fails to
        // arrive would leave Home showing one the server no longer holds.
        const covers = await homeCoverChoices(asker);
        const pending = await loadPendingSurprise(db, userId);
        const result = await proposeSurprise(db, {
          ownerUserId: userId,
          adventurous: adventurous ?? false,
          skipProfile: false,
          ...(theme ? { theme } : {}),
          vocal: theme && isSungTheme(theme) ? 'vocal' : (vocal ?? 'taste'),
          replaces: pending?.id ?? null,
          ...(signal ? { signal } : {}),
        });
        if (!result.ok) {
          switch (result.reason) {
            case 'busy':
              return notOffered(BUSY);
            case 'rate_limited':
              return notOffered(RATE_LIMITED);
            default:
              return notOffered(result.message);
          }
        }

        const { proposal } = result;
        const card: Extract<AssistantCard, { kind: 'surprise' }> = {
          kind: 'surprise',
          suggestion: {
            id: proposal.id,
            adventurous: proposal.adventurous,
            title: proposal.title,
            mood: proposal.mood,
            genres: proposal.genres,
            energy: proposal.energy,
            vocalMode: proposal.vocalMode,
            voiceGender: proposal.voiceGender,
            language: proposal.language,
          },
          targetDurationMinutes:
            targetDurationMinutes ?? (noLimit ? null : proposal.edit.durationMinutes),
          ...covers,
        };
        return proposed(card);
      }),
  };
}
