// `findMusic`: the asking user's Sessions, Playlists and Tracks, found the way
// the app finds them. A query goes to the app's own search, no query reads the
// lists the app's pages show, both as this user. A result is a short list of
// ids and names: the tools that play or file something take those ids. A
// search that matches nothing answers with the names spelled most like the
// query, a lyrics search with the lyric lines spelled most like it, so the
// model can tell which one a near miss meant.

import {
  closestNames,
  getLibraryTracks,
  getUsageLimits,
  searchPlaylists,
  searchSessions,
  searchTracks,
  type OwnerAttribution,
  type SearchArgs,
  type SearchGroup,
  type SearchMatch,
} from '@liedmotif/db';
import type { LlmTool } from '@liedmotif/providers';
import {
  findMusicInputSchema,
  limitDay,
  MAX_SEARCH_QUERY_LENGTH,
  type FindMusicInput,
  type SearchMatchField,
} from '@liedmotif/shared';
import { loungeOwnerDisplayName } from '@/components/lounge/lounge-view-model';
import { MIN_SEARCH_QUERY_LENGTH } from '@/components/search/search-model';
import { loadPlaylistSummaries } from '@/lib/library/playlists';
import { loadSessionList } from '@/lib/sessions/sessions';
import { named, quoted, trackCount } from './music-names';
import { FIND_MUSIC_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';

/** How many rows one result lists. */
const FIND_MUSIC_LIMIT = 10;

/**
 * How many names a search that matched nothing offers. Most are unrelated;
 * the list is this long so a name the spelling ranks low, one with two letters
 * swapped, is still on it for the model to recognise.
 */
const CLOSEST_NAMES_LIMIT = 50;

const KIND_NAMES: Record<FindMusicInput['kind'], string> = {
  session: 'Session',
  playlist: 'Playlist',
  track: 'Track',
};

/** The Library's Track lists, under the names its tabs show. */
export const LIST_NAMES: Record<NonNullable<FindMusicInput['list']>, string> = {
  saved: 'Saved',
  favorites: 'Favorites',
  history: 'History',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Now, and the Instance timezone whose calendar "today" and "yesterday" are counted in. */
interface Clock {
  now: Date;
  timeZone: string;
}

async function instanceClock(db: AssistantAsker['db']): Promise<Clock> {
  return { now: new Date(), timeZone: (await getUsageLimits(db)).resetTimezone };
}

/** The calendar date of `at` in `timeZone`, as whole days since the epoch. */
const calendarDay = (at: Date, timeZone: string) =>
  Date.parse(limitDay(at, timeZone).date) / DAY_MS;

/** When a Session was last active, in whole days: a model answers "last week" from that, not from a date. */
function lastActive(at: Date, { now, timeZone }: Clock): string {
  const days = calendarDay(now, timeZone) - calendarDay(at, timeZone);
  if (days <= 0) return 'last active today';
  return days === 1 ? 'last active yesterday' : `last active ${days} days ago`;
}

/** One row: what it is, then at most two short fields. */
const row = (name: string | null, id: string, ...fields: (string | null)[]) =>
  [named(name, id), ...fields.filter((field) => field !== null)].join(' · ');

/** What a row matched: a search hit's match, or a lyric line spelled near the query. */
type RowMatch = Pick<SearchMatch, 'field' | 'snippet'>;

/** What a search hit matched, when its row does not show that already. */
function matched(match: RowMatch | undefined, shown: readonly SearchMatchField[]) {
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
  clock: Clock,
): string {
  return row(
    session.title,
    session.id,
    session.status === 'active' || !session.lastActiveAt
      ? 'active now'
      : lastActive(new Date(session.lastActiveAt), clock),
    matched(session.match, ['name']),
  );
}

/** Whose a Playlist is, when it is another user's. */
const sharedBy = (owner: OwnerAttribution | null | undefined) =>
  owner ? `shared by ${quoted(loungeOwnerDisplayName(owner.artistName, owner.name))}` : null;

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
    sharedBy(playlist.owner) ?? matched(playlist.match, ['name']),
  );
}

/** A Track's own Session is on its row, so a hit there needs no second mention. */
function trackRow(track: {
  id: string;
  title: string | null;
  originSessionTitle: string | null;
  match?: RowMatch;
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

function listed(heading: string, { rows, more }: Listing, none: string): string {
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

/** One kind's Search hits, as the rows a result lists. */
async function searchHits(
  db: AssistantAsker['db'],
  kind: FindMusicInput['kind'],
  args: SearchArgs,
): Promise<Listing> {
  if (kind === 'track') return hits(await searchTracks(db, args), trackRow);
  if (kind === 'playlist') return hits(await searchPlaylists(db, args), playlistRow);
  const clock = await instanceClock(db);
  return hits(await searchSessions(db, args), (hit) => sessionRow(hit, clock));
}

/** The names of one kind spelled most like the query, as rows. */
async function closestRows(
  db: AssistantAsker['db'],
  kind: FindMusicInput['kind'],
  { ownerUserId, query }: SearchArgs,
): Promise<Listing> {
  const closest = await closestNames(db, { ownerUserId, kind, query, limit: CLOSEST_NAMES_LIMIT });
  return { rows: closest.map(({ id, name, owner }) => row(name, id, sharedBy(owner))), more: null };
}

/**
 * The app's search, as this user. Lyrics are sung by Tracks only, so a lyrics
 * search is one for Tracks whatever kind came with it. Search that matches
 * nothing lists the closest-spelled names or lyric lines instead: what a user
 * says is often a word or a sign off the name or line they mean.
 */
async function search(
  { db, userId }: AssistantAsker,
  kind: FindMusicInput['kind'],
  query: string,
  lyrics: boolean,
): Promise<string> {
  const args: SearchArgs = {
    ownerUserId: userId,
    query,
    limit: FIND_MUSIC_LIMIT,
    sort: 'relevance',
  };
  const text = quoted(query);
  if (lyrics) {
    const none = `No Track has ${text} in its lyrics.`;
    // On a miss Search itself answers with the closest lyric lines.
    const found = await searchTracks(db, { ...args, lyricsOnly: true });
    return listed(
      found.closeMatches
        ? `${none} The lyric lines spelled nearest, none may be the one meant:`
        : `Tracks with ${text} in their lyrics:`,
      hits(found, trackRow),
      none,
    );
  }
  const what = KIND_NAMES[kind];
  const none = `No ${what} matches ${text}.`;
  const found = await searchHits(db, kind, args);
  return found.rows.length > 0
    ? listed(`${what}s matching ${text}:`, found, none)
    : listed(
        `${none} The names spelled nearest, none may be the one meant:`,
        await closestRows(db, kind, args),
        none,
      );
}

/** The lists the app's own pages open with, as this user. */
async function mostRecent(
  { db, userId }: AssistantAsker,
  kind: FindMusicInput['kind'],
  list: NonNullable<FindMusicInput['list']>,
): Promise<string> {
  if (kind === 'track') {
    const { items, nextCursor } = await getLibraryTracks(db, {
      ownerUserId: userId,
      view: list,
      limit: FIND_MUSIC_LIMIT,
    });
    return listed(
      `Tracks in ${LIST_NAMES[list]}, most recent first:`,
      head(items.map(trackRow), nextCursor),
      `There are no Tracks in ${LIST_NAMES[list]}.`,
    );
  }
  if (kind === 'playlist') {
    const { playlists, nextCursor } = await loadPlaylistSummaries(db, userId, {
      limit: FIND_MUSIC_LIMIT,
    });
    return listed(
      'Playlists, in the order the Library lists them:',
      head(playlists.map(playlistRow), nextCursor),
      'There are no Playlists yet.',
    );
  }
  const clock = await instanceClock(db);
  const { activeSession, items, nextCursor } = await loadSessionList(db, userId, {
    limit: FIND_MUSIC_LIMIT,
    includeActive: true,
    includePinned: false,
  });
  const sessions = [...(activeSession ? [activeSession] : []), ...items];
  return listed(
    'Sessions, most recent first:',
    head(
      sessions.map((session) => sessionRow(session, clock)),
      nextCursor,
    ),
    'There are no Sessions yet.',
  );
}

export function createFindMusicTool(asker: AssistantAsker): LlmTool<FindMusicInput> {
  return {
    name: FIND_MUSIC_TOOL_NAME,
    description:
      "Finds the user's Sessions, Playlists or Tracks: by a search query, Tracks also by their lyrics, or the most recent when no query is given. Returns ids and names; a query that matches nothing returns the names, or for lyrics the lyric lines, spelled most like it.",
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
