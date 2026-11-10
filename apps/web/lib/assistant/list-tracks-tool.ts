// `listTracks`: the Tracks of one Session or one Playlist, in the order it
// plays them. The id is only ever a question to the database, asked as the
// asking user: one they cannot see is answered like one that names nothing.

import { getSessionById, listSessionTracks } from '@liedmotif/db';
import type { LlmTool } from '@liedmotif/providers';
import { listTracksInputSchema, type ListTracksInput } from '@liedmotif/shared';
import { formatTrackDuration } from '@/components/library/library-view-model';
import { named, trackCount } from './music-names';
import { isId, readablePlaylist } from './readable-music';
import { LIST_TRACKS_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';

/** How many Tracks one result lists. */
const LIST_TRACKS_LIMIT = 30;

/** The head of one Session's or Playlist's Tracks, and how many it has in all. */
interface TrackList {
  name: string | null;
  total: number;
  tracks: { id: string; title: string | null; durationSeconds: number | null }[];
}

async function sessionTracks(
  { db, userId }: AssistantAsker,
  sessionId: string,
): Promise<TrackList | null> {
  const [session, page] = await Promise.all([
    getSessionById(db, { ownerUserId: userId, sessionId }),
    listSessionTracks(db, {
      ownerUserId: userId,
      sessionId,
      cursor: null,
      limit: LIST_TRACKS_LIMIT,
    }),
  ]);
  return session && page ? { name: session.title, total: page.total, tracks: page.items } : null;
}

async function playlistTracks(
  asker: AssistantAsker,
  playlistId: string,
): Promise<TrackList | null> {
  const detail = await readablePlaylist(asker, playlistId, LIST_TRACKS_LIMIT);
  return (
    detail && {
      name: detail.playlist.name,
      total: detail.playlist.trackCount,
      tracks: detail.items,
    }
  );
}

export function createListTracksTool(asker: AssistantAsker): LlmTool<ListTracksInput> {
  return {
    name: LIST_TRACKS_TOOL_NAME,
    description:
      'The Tracks of one Session or one Playlist, in order, by the id another tool returned for it.',
    inputSchema: listTracksInputSchema,
    async execute({ in: where, id }) {
      const kind = where === 'session' ? 'Session' : 'Playlist';
      // An id that is no id cannot name anything, and the database would
      // refuse to compare it.
      const list = !isId(id)
        ? null
        : where === 'session'
          ? await sessionTracks(asker, id)
          : await playlistTracks(asker, id);
      if (!list) return `No ${kind} with that id.`;
      const heading = `${kind} ${named(list.name, id)}`;
      if (list.tracks.length === 0) return `${heading} has no Tracks.`;
      return [
        `${heading}, ${trackCount(list.total)} in order:`,
        ...list.tracks.map(({ id: trackId, title, durationSeconds }, index) =>
          [
            `${index + 1}. ${named(title, trackId)}`,
            ...(durationSeconds === null ? [] : [formatTrackDuration(durationSeconds)]),
          ].join(' · '),
        ),
        ...(list.total > list.tracks.length
          ? [`Only the first ${list.tracks.length} are listed.`]
          : []),
      ].join('\n');
    },
  };
}
