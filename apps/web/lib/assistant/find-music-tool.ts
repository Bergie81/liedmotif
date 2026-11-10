// `findMusic`: the asking user's Sessions, Playlists and Tracks, found the way
// the app finds them. A query goes to the app's own search, no query reads the
// lists the app's pages show, both as this user. A result is a short list of
// ids and names: the tools that play or file something take those ids.

import {
  getLibraryTracks,
  searchPlaylists,
  searchSessions,
  searchTracks,
  type OwnerAttribution,
  type SearchGroup,
  type SearchMatch,
} from '@liedmotif/db';
import type { LlmTool } from '@liedmotif/providers';
import {
  findMusicInputSchema,
  MAX_SEARCH_QUERY_LENGTH,
  type FindMusicInput,
  type SearchMatchField,
} from '@liedmotif/shared';
import { loungeOwnerDisplayName } from '@/components/lounge/lounge-view-model';
import { loadPlaylistSummaries } from '@/lib/playlists';
import { loadSessionList } from '@/lib/sessions';
import { named, quoted, trackCount } from './music-names';
import { FIND_MUSIC_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';

/** How many rows one result lists. */
export const FIND_MUSIC_LIMIT = 10;

/** The shortest query the app's search takes. */
const MIN_SEARCH_QUERY_LENGTH = 2;

const DAY_MS = 24 * 60 * 60 * 1000;
const utcDay = (at: Date) => Math.floor(at.getTime() / DAY_MS);

/** When a Session was last active, in whole days: a model answers "last week" from that, not from a date. */
function lastActive(at: Date, now: Date): string {
  const days = utcDay(now) - utcDay(at);
  if (days <= 0) return 'last active today';
  return days === 1 ? 'last active yesterday' : `last active ${days} days ago`;
}

/** One row: what it is, then at most two short fields. */
const row = (name: string | null, id: string, ...fields: (string | null)[]) =>
  [named(name, id), ...fields.filter((field) => field !== null)].join(' · ');

/** What a search hit matched, when its row does not show that already. */
function matched(match: SearchMatch | undefined, shown: readonly SearchMatchField[]) {
  return !match || shown.includes(match.field) ? null : `${match.field}: ${quoted(match.snippet)}`;
}

function sessionRow(
  session: {
    id: string;
    title: string | null;
    status: string;
    lastActiveAt?: string | Date;
    match?: SearchMatch;
  },
  now: Date,
): string {
  return row(
    session.title,
    session.id,
    session.status === 'active' || !session.lastActiveAt
      ? 'active now'
      : lastActive(new Date(session.lastActiveAt), now),
    matched(session.match, ['name']),
  );
}

/** A Playlist of another user says whose it is; that tells more than what matched. */
function playlistRow(playlist: {
  id: string;
  name: string;
  trackCount: number;
  owner?: OwnerAttribution | null;
  match?: SearchMatch;
}): string {
  return row(
    playlist.name,
    playlist.id,
    trackCount(playlist.trackCount),
    playlist.owner
      ? `shared by ${quoted(loungeOwnerDisplayName(playlist.owner.artistName, playlist.owner.name))}`
      : matched(playlist.match, ['name']),
  );
}

/** A Track's own Session is on its row, so a hit there needs no second mention. */
function trackRow(track: {
  id: string;
  title: string | null;
  originSessionTitle: string | null;
  match?: SearchMatch;
}): string {
  return row(
    track.title,
    track.id,
    track.originSessionTitle === null ? null : `Session ${quoted(track.originSessionTitle)}`,
    matched(track.match, ['name', 'session']),
  );
}

/** The rows of one answer, and the line that says they are not all there is. */
interface Listing {
  rows: string[];
  more: string | null;
}

function told(heading: string, { rows, more }: Listing, none: string): string {
  if (rows.length === 0) return none;
  return [heading, ...rows.map((line) => `- ${line}`), ...(more ? [more] : [])].join('\n');
}

/** The hits of a search: it counted every match, so the line says how many there are. */
function hits<Hit>(group: SearchGroup<Hit>, toRow: (hit: Hit) => string): Listing {
  const { items, matchCount } = group;
  return {
    rows: items.map(toRow),
    more:
      matchCount > items.length
        ? `${matchCount} match: only the first ${items.length} are listed.`
        : null,
  };
}

/** The head of a paged list; a first page may hold more than it was asked for. */
function head(rows: string[], nextCursor: string | null): Listing {
  return {
    rows: rows.slice(0, FIND_MUSIC_LIMIT),
    more:
      nextCursor !== null || rows.length > FIND_MUSIC_LIMIT
        ? `More exist: only the first ${FIND_MUSIC_LIMIT} are listed.`
        : null,
  };
}

/**
 * The app's search, as this user. Lyrics are sung by Tracks only, so a lyrics
 * search is one for Tracks whatever kind came with it.
 */
async function search(
  { db, userId }: AssistantAsker,
  kind: FindMusicInput['kind'],
  query: string,
  lyrics: boolean,
): Promise<string> {
  const args = {
    ownerUserId: userId,
    query,
    limit: FIND_MUSIC_LIMIT,
    sort: 'relevance',
  } as const;
  const text = quoted(query);
  if (lyrics) {
    return told(
      `Tracks with ${text} in their lyrics:`,
      hits(await searchTracks(db, { ...args, lyricsOnly: true }), trackRow),
      `No Track has ${text} in its lyrics.`,
    );
  }
  if (kind === 'track') {
    return told(
      `Tracks matching ${text}:`,
      hits(await searchTracks(db, args), trackRow),
      `No Track matches ${text}.`,
    );
  }
  if (kind === 'playlist') {
    return told(
      `Playlists matching ${text}:`,
      hits(await searchPlaylists(db, args), playlistRow),
      `No Playlist matches ${text}.`,
    );
  }
  const now = new Date();
  return told(
    `Sessions matching ${text}:`,
    hits(await searchSessions(db, args), (hit) => sessionRow(hit, now)),
    `No Session matches ${text}.`,
  );
}

/** The lists the app's own pages open with, as this user. */
async function mostRecent(
  { db, userId }: AssistantAsker,
  kind: FindMusicInput['kind'],
  list: NonNullable<FindMusicInput['list']>,
): Promise<string> {
  const limit = FIND_MUSIC_LIMIT;
  if (kind === 'track') {
    const { items, nextCursor } = await getLibraryTracks(db, {
      ownerUserId: userId,
      view: list,
      limit,
    });
    return told(
      `Tracks in ${list}, most recent first:`,
      head(items.map(trackRow), nextCursor),
      `There are no Tracks in ${list}.`,
    );
  }
  if (kind === 'playlist') {
    const { playlists, nextCursor } = await loadPlaylistSummaries(db, userId, { limit });
    return told(
      'Playlists, in the order the Library lists them:',
      head(playlists.map(playlistRow), nextCursor),
      'There are no Playlists yet.',
    );
  }
  const now = new Date();
  const { activeSession, items, nextCursor } = await loadSessionList(db, userId, {
    limit,
    includeActive: true,
    includePinned: false,
  });
  const sessions = [...(activeSession ? [activeSession] : []), ...items];
  return told(
    'Sessions, most recent first:',
    head(
      sessions.map((session) => sessionRow(session, now)),
      nextCursor,
    ),
    'There are no Sessions yet.',
  );
}

export function createFindMusicTool(asker: AssistantAsker): LlmTool<FindMusicInput> {
  return {
    name: FIND_MUSIC_TOOL_NAME,
    description:
      "Finds the user's Sessions, Playlists or Tracks: by a search query, Tracks also by their lyrics, or the most recent when no query is given. Returns ids and names.",
    inputSchema: findMusicInputSchema,
    async execute({ kind, query, lyrics, list }) {
      const words = (query ?? '').trim().slice(0, MAX_SEARCH_QUERY_LENGTH);
      if (!words && !lyrics) return mostRecent(asker, kind, list ?? 'history');
      if (words.length < MIN_SEARCH_QUERY_LENGTH) {
        return `A search needs at least ${MIN_SEARCH_QUERY_LENGTH} characters.`;
      }
      return search(asker, kind, words, lyrics === true);
    },
  };
}
