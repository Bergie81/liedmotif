// `createPlaylist`, `renamePlaylist`, `pinPlaylist`: what the asking user can
// do to a Playlist of their own from the Library's menus, through the same
// functions. There is no unpin and no delete here.

import { createPlaylist, renamePlaylist, setPlaylistLibraryPinned } from '@liedmotif/db';
import type { LlmTool } from '@liedmotif/providers';
import {
  MAX_PLAYLIST_NAME_LENGTH,
  createPlaylistInputSchema,
  createPlaylistRequestSchema,
  pinPlaylistInputSchema,
  renamePlaylistInputSchema,
  type CreatePlaylistInput,
  type PinPlaylistInput,
  type RenamePlaylistInput,
} from '@liedmotif/shared';
import { done, NO_SUCH_PLAYLIST, refused } from './library-action';
import { ownPlaylist } from './readable-music';
import {
  CREATE_PLAYLIST_TOOL_NAME,
  PIN_PLAYLIST_TOOL_NAME,
  RENAME_PLAYLIST_TOOL_NAME,
} from './tool-names';
import type { AssistantAsker } from './tools';
import type { TurnActions } from './turn-actions';

const BAD_NAME = `A Playlist name has 1 to ${MAX_PLAYLIST_NAME_LENGTH} characters.`;

/** The name as the app's own field would store it, or null when it would refuse it. */
function playlistName(name: string): string | null {
  const parsed = createPlaylistRequestSchema.shape.name.safeParse(name);
  return parsed.success ? parsed.data : null;
}

export function createCreatePlaylistTool(
  { db, userId }: AssistantAsker,
  actions: TurnActions,
): LlmTool<CreatePlaylistInput> {
  return {
    name: CREATE_PLAYLIST_TOOL_NAME,
    description: 'Creates a new, empty Playlist for the user under the name they gave.',
    inputSchema: createPlaylistInputSchema,
    execute: (input) =>
      actions.take('done', async () => {
        const name = playlistName(input.name);
        if (name === null) return refused(BAD_NAME);
        const playlist = await createPlaylist(db, { ownerUserId: userId, name });
        return done({
          action: 'createPlaylist',
          playlist: { id: playlist.id, name: playlist.name },
        });
      }),
  };
}

export function createRenamePlaylistTool(
  asker: AssistantAsker,
  actions: TurnActions,
): LlmTool<RenamePlaylistInput> {
  const { db, userId } = asker;
  return {
    name: RENAME_PLAYLIST_TOOL_NAME,
    description: "Gives one of the user's own Playlists a new name. Favorites keeps its name.",
    inputSchema: renamePlaylistInputSchema,
    execute: (input) =>
      actions.take('done', async () => {
        const name = playlistName(input.name);
        if (name === null) return refused(BAD_NAME);
        const playlist = await ownPlaylist(asker, input.playlistId);
        if (!playlist) return refused(NO_SUCH_PLAYLIST);
        const result = await renamePlaylist(db, {
          ownerUserId: userId,
          playlistId: playlist.id,
          name,
        });
        if (result === null) return refused(NO_SUCH_PLAYLIST);
        if (result === 'system') return refused('Favorites cannot be renamed.');
        return done({
          action: 'renamePlaylist',
          playlist: { id: playlist.id, name },
          previousName: playlist.name,
        });
      }),
  };
}

export function createPinPlaylistTool(
  asker: AssistantAsker,
  actions: TurnActions,
): LlmTool<PinPlaylistInput> {
  const { db, userId } = asker;
  return {
    name: PIN_PLAYLIST_TOOL_NAME,
    description:
      "Pins one of the user's own Playlists, so it lists first under Playlists in their Library.",
    inputSchema: pinPlaylistInputSchema,
    execute: ({ playlistId }) =>
      actions.take('done', async () => {
        const playlist = await ownPlaylist(asker, playlistId);
        if (!playlist) return refused(NO_SUCH_PLAYLIST);
        const result = await setPlaylistLibraryPinned(db, {
          ownerUserId: userId,
          playlistId: playlist.id,
          pinned: true,
        });
        // The asker has this Playlist, so what the write turned away is one
        // the Library shows no pin on: Favorites.
        if (result === 'not_found') return refused('That Playlist cannot be pinned.');
        return done({
          action: 'pinPlaylist',
          playlist: { id: playlist.id, name: playlist.name },
        });
      }),
  };
}
