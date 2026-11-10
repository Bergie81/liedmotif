// `addToPlaylist`: appends Tracks to one of the asking user's own Playlists,
// through the function the app's own Add Tracks calls. It only ever adds, and
// only that user's Tracks to that user's Playlists.

import { addPlaylistTracks } from '@liedmotif/db';
import type { LlmTool } from '@liedmotif/providers';
import {
  ASSISTANT_MAX_TRACKS_PER_ADD,
  addToPlaylistInputSchema,
  type AddToPlaylistInput,
} from '@liedmotif/shared';
import { done, NO_SUCH_PLAYLIST, NO_TRACK_PLAYING, refused } from './library-action';
import { named } from './music-names';
import { isId, ownPlaylist, readableTrackTitle } from './readable-music';
import { ADD_TO_PLAYLIST_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';
import type { TurnActions } from './turn-actions';

const NOT_ADDABLE = "not found, not this user's own, or removed";

export function createAddToPlaylistTool(
  asker: AssistantAsker,
  actions: TurnActions,
): LlmTool<AddToPlaylistInput> {
  const { db, userId, player } = asker;
  return {
    name: ADD_TO_PLAYLIST_TOOL_NAME,
    description: `Adds up to ${ASSISTANT_MAX_TRACKS_PER_ADD} of the user's Tracks to one of their Playlists. Leave out trackIds for the Track that is playing now ("add this").`,
    inputSchema: addToPlaylistInputSchema,
    execute: ({ playlistId, trackIds: given }) =>
      actions.take('done', async () => {
        const asked = [...new Set(given?.length ? given : player?.trackId ? [player.trackId] : [])];
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
        const trackIds = asked.filter(isId);
        const titles = new Map(
          await Promise.all(
            trackIds.map(async (id) => [id, await readableTrackTitle(asker, id)] as const),
          ),
        );
        const result = await addPlaylistTracks(db, { ownerUserId: userId, playlistId, trackIds });
        if (!result) return refused(NO_SUCH_PLAYLIST);

        const { added } = result;
        const notAdded = asked.length - trackIds.length + result.refused.length;
        const alreadyIn = asked.length - added.length - notAdded;
        const rest = [
          ...(alreadyIn > 0
            ? [`${alreadyIn} ${alreadyIn === 1 ? 'was' : 'were'} already in it.`]
            : []),
          ...(notAdded > 0 ? [`${notAdded} could not be added: ${NOT_ADDABLE}.`] : []),
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
            tracks: added.map((id) => ({ id, name: titles.get(id) ?? null })),
          },
          ...rest,
        );
      }),
  };
}
