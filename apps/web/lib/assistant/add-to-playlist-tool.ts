// `addToPlaylist`: appends Tracks to one of the asking user's own Playlists,
// through the function the app's own Add Tracks calls. It only ever adds, and
// only to that user's Playlists: their own Tracks, and Tracks shared with them
// in the Lounge, filed as Shared references under the picker's own check.

import { addPlaylistTracks } from '@liedmotif/db';
import type { LlmTool } from '@liedmotif/providers';
import {
  ASSISTANT_MAX_TRACKS_PER_ADD,
  addToPlaylistInputSchema,
  isCuratedPlaylist,
  type AddToPlaylistInput,
} from '@liedmotif/shared';
import { askedTracks, done, NO_SUCH_PLAYLIST, NO_TRACK_PLAYING, refused } from './library-action';
import { named } from './music-names';
import { isId, ownPlaylist, readableTrackTitle } from './readable-music';
import { ADD_TO_PLAYLIST_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';
import type { TurnActions } from './turn-actions';

/** "1 was" / "2 were": the counts the model is told, one sentence per cause. */
function counted(n: number): string {
  return `${n} ${n === 1 ? 'was' : 'were'}`;
}

export function createAddToPlaylistTool(
  asker: AssistantAsker,
  actions: TurnActions,
): LlmTool<AddToPlaylistInput> {
  const { db, userId, player } = asker;
  return {
    name: ADD_TO_PLAYLIST_TOOL_NAME,
    description: `Adds up to ${ASSISTANT_MAX_TRACKS_PER_ADD} Tracks to one of the user's own Playlists: their own Tracks, and Tracks shared with them in the Lounge. Leave out trackIds for the Track that is playing now ("add this").`,
    inputSchema: addToPlaylistInputSchema,
    execute: ({ playlistId, trackIds: given }) =>
      actions.take('done', async () => {
        const asked = askedTracks(given, player);
        if (asked.length === 0) return refused(NO_TRACK_PLAYING);
        if (asked.length > ASSISTANT_MAX_TRACKS_PER_ADD) {
          return refused(
            `At most ${ASSISTANT_MAX_TRACKS_PER_ADD} Tracks can be added at a time, and these are ${asked.length}.`,
          );
        }
        const playlist = await ownPlaylist(asker, playlistId);
        if (!playlist) return refused(NO_SUCH_PLAYLIST);
        const where = named(playlist.name, playlist.id);

        // Everything the receipt names is read before the write, so nothing
        // can fail between the write and its receipt.
        const trackIds = asked.filter(isId).map((id) => id.toLowerCase());
        const titles = new Map(
          await Promise.all(
            trackIds.map(async (id) => [id, await readableTrackTitle(asker, id)] as const),
          ),
        );
        const result = await addPlaylistTracks(db, {
          ownerUserId: userId,
          playlistId,
          trackIds,
          includeLoungeTracks: true,
        });
        if (!result) return refused(NO_SUCH_PLAYLIST);

        const { added, removed, failed } = result;
        const notFound = asked.length - trackIds.length + result.notFound.length;
        const notAdded = removed.length + failed.length + notFound;
        const alreadyIn = asked.length - added.length - notAdded;
        const rest = [
          ...(alreadyIn > 0 ? [`${counted(alreadyIn)} already in it.`] : []),
          ...(removed.length > 0
            ? [`${counted(removed.length)} removed (Disliked or deleted), so not added.`]
            : []),
          ...(failed.length > 0
            ? [`${counted(failed.length)} a failed generation with no audio, so not added.`]
            : []),
          ...(notFound > 0
            ? [
                `${counted(notFound)} not found among this user's Tracks or the Tracks shared with them, so not added.`,
              ]
            : []),
        ];
        if (added.length === 0) {
          return refused(
            notAdded === 0
              ? `Every one of those Tracks is already in ${where}.`
              : [`No Track was added to ${where}.`, ...rest].join(' '),
          );
        }
        return done(
          {
            action: 'addToPlaylist',
            playlist: { id: playlist.id, name: playlist.name },
            retention:
              playlist.kind === 'favorites'
                ? 'favorite'
                : isCuratedPlaylist(playlist)
                  ? 'curated'
                  : 'saved',
            tracks: added.map((id) => ({ id, name: titles.get(id) ?? null })),
          },
          ...rest,
        );
      }),
  };
}
