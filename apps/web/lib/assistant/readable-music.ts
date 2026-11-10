// How the Assistant's tools name a Session, Playlist or Track to the model,
// and which Playlists the asking user may read. Every tool that hands out or
// takes an id goes through here, so they agree on both.

import {
  getLoungePlaylistDetail,
  getPlaylistDetail,
  type PlaylistDetailResult,
} from '@liedmotif/db';
import type { AssistantAsker } from './tools';

/** A name as the model reads it: quoted, so text a user wrote stays told apart from the rest. */
export const quoted = (name: string | null) => JSON.stringify(name ?? 'Untitled');

/** One thing by its name and the id the tools take for it. */
export const named = (name: string | null, id: string) => `${quoted(name)} (id ${id})`;

/** How many Tracks something holds, as the app counts them. */
export const trackCount = (count: number) => `${count} ${count === 1 ? 'Track' : 'Tracks'}`;

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
