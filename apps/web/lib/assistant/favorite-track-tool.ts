// `favoriteTrack`: adds one Track to the asking user's Favorites, through the
// function the app's own star calls. It only ever adds: there is no way to
// take a Track out of Favorites from here.

import { ensureFavoritesPlaylist, setTrackFavorited } from '@liedmotif/db';
import type { LlmTool } from '@liedmotif/providers';
import { favoriteTrackInputSchema, type FavoriteTrackInput } from '@liedmotif/shared';
import { done, NO_SUCH_TRACK, NO_TRACK_PLAYING, refused } from './library-action';
import { readableTrackTitle } from './readable-music';
import { FAVORITE_TRACK_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';
import type { TurnActions } from './turn-actions';

export function createFavoriteTrackTool(
  asker: AssistantAsker,
  actions: TurnActions,
): LlmTool<FavoriteTrackInput> {
  const { db, userId, player } = asker;
  return {
    name: FAVORITE_TRACK_TOOL_NAME,
    description:
      'Adds one Track to the user\'s Favorites. Leave out trackId for the Track that is playing now ("favorite this").',
    inputSchema: favoriteTrackInputSchema,
    execute: ({ trackId: given }) =>
      actions.take('done', async () => {
        const trackId = given || player?.trackId;
        if (!trackId) return refused(NO_TRACK_PLAYING);
        // Everything the receipt names is read before the write, so nothing
        // can fail between the write and its receipt.
        const title = await readableTrackTitle(asker, trackId);
        if (title === undefined) return refused(NO_SUCH_TRACK);
        const favorites = await ensureFavoritesPlaylist(db, { ownerUserId: userId });
        const flags = await setTrackFavorited(db, {
          ownerUserId: userId,
          trackId,
          favorited: true,
        });
        if (!flags) return refused(NO_SUCH_TRACK);
        if (flags === 'removed') return refused('That Track was removed.');
        if (flags === 'failed')
          return refused('That Track could not be kept, so it cannot be favorited.');
        return done({
          action: 'favoriteTrack',
          track: { id: trackId, name: title },
          playlist: { id: favorites.id, name: favorites.name },
        });
      }),
  };
}
