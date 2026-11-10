// Which Playlists and Tracks the asking user may read, and which Playlists are
// theirs to change. Every tool that takes the id of one asks through here, so
// such an id is only ever a question to the database, asked as that user.

import {
  getLoungePlaylistDetail,
  getPlaylistDetail,
  getReadableTrackDetails,
  listPlaylists,
  type PlaylistDetailResult,
  type PlaylistSummary,
} from '@liedmotif/db';
import { uuidSchema } from '@liedmotif/shared';
import type { AssistantAsker } from './tools';

/** Whether the model handed over something shaped like an id; the database refuses to compare anything else. */
export const isId = (id: string) => uuidSchema.safeParse(id).success;

/**
 * A Playlist with its first `limit` Tracks in order, when the asker may see
 * it: their own, or one in the Lounge for them. Null for every other id.
 */
export async function readablePlaylist(
  { db, userId }: AssistantAsker,
  playlistId: string,
  limit: number,
): Promise<PlaylistDetailResult | null> {
  const own = await getPlaylistDetail(db, { ownerUserId: userId, playlistId, limit });
  if (own) return own;
  return getLoungePlaylistDetail(db, { viewerUserId: userId, playlistId, limit });
}

/** One of the asker's own Playlists, Favorites included; null for every other id. */
export async function ownPlaylist(
  { db, userId }: AssistantAsker,
  playlistId: string,
): Promise<PlaylistSummary | null> {
  if (!isId(playlistId)) return null;
  const [playlist] = await listPlaylists(db, { ownerUserId: userId, playlistId });
  return playlist ?? null;
}

/**
 * The title of a Track the asker may hear: their own, or one in the Lounge for
 * them. `undefined` for every other id; `null` is a Track without a title.
 */
export async function readableTrackTitle(
  { db, userId }: AssistantAsker,
  trackId: string,
): Promise<string | null | undefined> {
  if (!isId(trackId)) return undefined;
  const track = await getReadableTrackDetails(db, { viewerUserId: userId, trackId });
  return track ? track.title : undefined;
}
