// `proposeMoreLikeThis`: prepares a new Session seeded from Tracks and starts
// nothing. A new Session buys music, so the tool only checks what the More
// Like This route would refuse, and hands the chat a card. The user's click on
// that card is what calls the route.

import type { LlmTool } from '@liedmotif/providers';
import {
  MAX_SEED_TRACKS,
  MAX_USER_PROMPT_LENGTH,
  proposeMoreLikeThisInputSchema,
  type ProposeMoreLikeThisInput,
} from '@liedmotif/shared';
import { askedTracks, NO_SUCH_TRACK, NO_TRACK_PLAYING } from './library-action';
import { newSessionLength, notOffered, proposed } from './proposal';
import { readableTrackTitle } from './readable-music';
import { PROPOSE_MORE_LIKE_THIS_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';
import type { TurnActions } from './turn-actions';

const CONTEXT_TOO_LONG = `A context is at most ${MAX_USER_PROMPT_LENGTH} characters. Ask the user to say it shorter.`;

export function createProposeMoreLikeThisTool(
  asker: AssistantAsker,
  actions: TurnActions,
): LlmTool<ProposeMoreLikeThisInput> {
  return {
    name: PROPOSE_MORE_LIKE_THIS_TOOL_NAME,
    description: `Prepares More Like This: a new Session in the style of up to ${MAX_SEED_TRACKS} Tracks the user can play, and shows the user a card for it. Starts nothing and spends nothing: the Session starts only when the user confirms the card. Leave out trackIds for the Track that is playing now ("more like this"). Runs for a length in minutes, or with no limit: give the one the user named, and neither when they named none. A context says what the new Session is about or for: an occasion, a theme, people, what the track titles and lyrics are about ("more like this but for cooking"). It changes the Session's name, track titles, cover and lyrics, never how the music sounds. For a change to the sound ("more like this but faster") do not use this tool: prepare a new Session described from the Track's data, or a Change Vibe of the running Session.`,
    inputSchema: proposeMoreLikeThisInputSchema,
    execute: ({ trackIds: given, targetDurationMinutes, noLimit, context: givenContext }) =>
      actions.take('proposed', async () => {
        const asked = askedTracks(given, asker.player);
        if (asked.length === 0) return notOffered(NO_TRACK_PLAYING);
        if (asked.length > MAX_SEED_TRACKS) {
          return notOffered(
            `A Session is seeded from at most ${MAX_SEED_TRACKS} Tracks, and these are ${asked.length}.`,
          );
        }
        // Blank is no context, as the route reads it.
        const context = givenContext?.trim() || undefined;
        if (context !== undefined && context.length > MAX_USER_PROMPT_LENGTH) {
          return notOffered(CONTEXT_TOO_LONG);
        }
        // The read scope of the More Like This route: the asker's own Tracks
        // and the ones shared with them in the Lounge. Every seed has to be
        // in it, because the card names each one.
        const tracks = await Promise.all(
          asked.map(async (id) => ({ id, name: await readableTrackTitle(asker, id) })),
        );
        const seeds = tracks.flatMap(({ id, name }) => (name === undefined ? [] : [{ id, name }]));
        if (seeds.length < tracks.length) return notOffered(NO_SUCH_TRACK);
        // The length is the user's own for this new Session: never the seed
        // Session's, never the playing one's.
        const gate = await newSessionLength(asker, { targetDurationMinutes, noLimit });
        return 'refusal' in gate
          ? notOffered(gate.refusal)
          : proposed({
              kind: 'moreLikeThis',
              tracks: seeds,
              ...gate.length,
              ...(context !== undefined && { context }),
            });
      }),
  };
}
