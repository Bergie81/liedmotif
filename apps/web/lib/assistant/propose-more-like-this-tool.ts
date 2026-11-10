// `proposeMoreLikeThis`: prepares a new Session seeded from Tracks and starts
// nothing. A new Session buys music, so the tool only checks what the More
// Like This route would refuse, and hands the chat a card. The user's click on
// that card is what calls the route.

import type { LlmTool } from '@liedmotif/providers';
import {
  MAX_SEED_TRACKS,
  proposeMoreLikeThisInputSchema,
  type ProposeMoreLikeThisInput,
} from '@liedmotif/shared';
import { NO_SUCH_TRACK, NO_TRACK_PLAYING } from './library-action';
import { newSessionRefusal, notOffered, proposed } from './proposal';
import { readableTrackTitle } from './readable-music';
import { PROPOSE_MORE_LIKE_THIS_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';
import type { TurnActions } from './turn-actions';

export function createProposeMoreLikeThisTool(
  asker: AssistantAsker,
  actions: TurnActions,
): LlmTool<ProposeMoreLikeThisInput> {
  return {
    name: PROPOSE_MORE_LIKE_THIS_TOOL_NAME,
    description: `Prepares More Like This: a new Session in the style of up to ${MAX_SEED_TRACKS} Tracks the user can play, and shows the user a card for it. Starts nothing and spends nothing: the Session starts only when the user confirms the card. Leave out trackIds for the Track that is playing now ("more like this").`,
    inputSchema: proposeMoreLikeThisInputSchema,
    execute: ({ trackIds: given }) =>
      actions.take('proposed', async () => {
        const playing = asker.player?.trackId;
        const asked = [...new Set(given?.length ? given : playing ? [playing] : [])];
        if (asked.length === 0) return notOffered(NO_TRACK_PLAYING);
        if (asked.length > MAX_SEED_TRACKS) {
          return notOffered(
            `A Session is seeded from at most ${MAX_SEED_TRACKS} Tracks, and these are ${asked.length}.`,
          );
        }
        // The read scope of the More Like This route: the asker's own Tracks
        // and the ones shared with them in the Lounge. Every seed has to be
        // in it, because the card names each one.
        const tracks = await Promise.all(
          asked.map(async (id) => ({ id, name: await readableTrackTitle(asker, id) })),
        );
        const seeds = tracks.flatMap(({ id, name }) => (name === undefined ? [] : [{ id, name }]));
        if (seeds.length < tracks.length) return notOffered(NO_SUCH_TRACK);
        const refusal = await newSessionRefusal(asker);
        return refusal ? notOffered(refusal) : proposed({ kind: 'moreLikeThis', tracks: seeds });
      }),
  };
}
