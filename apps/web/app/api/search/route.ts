// GET /api/search — ranked, capped retrieval across Sessions, Tracks and
// Playlists. Read-only: no provider call, no LLM call, no write. A search whose
// exact words find nothing in any queried group answers with close matches
// instead, flagged `closeMatches`: the closest lyric lines in lyrics mode, else
// the closest names of each queried kind.
// The caps are server-fixed (5 per group under All, 50 on a scope tab); a
// client cannot ask for more, and there is no cursor to page with.

import { NextResponse } from 'next/server';
import {
  closeNameMatches,
  getSessionTrackActivities,
  searchPlaylists,
  searchSessions,
  searchTracks,
  type SearchGroup,
  type SearchMatch,
} from '@liedmotif/db';
import {
  EMPTY_SESSION_TRACK_ACTIVITY,
  SEARCH_ALL_GROUP_LIMIT,
  SEARCH_SCOPED_GROUP_LIMIT,
  searchRequestSchema,
  type SearchMatchContext,
  type SearchScope,
} from '@liedmotif/shared';
import { apiOk, requireOwnerId, validateInput } from '@/lib/http/api-response';
import { getDb } from '@/lib/db';
import { toPlaylistSummaryItem } from '@/lib/library/playlists';
import { toLibraryTrackItem } from '@/lib/library/tracks';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const url = new URL(request.url);
  const parsed = validateInput(
    searchRequestSchema,
    {
      q: url.searchParams.get('q') ?? undefined,
      scope: url.searchParams.get('scope') ?? undefined,
      sort: url.searchParams.get('sort') ?? undefined,
      lyrics: url.searchParams.get('lyrics') ?? undefined,
    },
    'Invalid search request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const db = getDb();
  // Lyrics mode is exclusive — only Tracks can match — so it collapses to the
  // tracks scope here, making it a single-group (scoped-cap) request like any
  // other tab. Groups out of scope are not queried at all (null, not empty).
  const scope = parsed.lyrics ? 'tracks' : parsed.scope;
  const base = {
    ownerUserId,
    query: parsed.q,
    limit: scope === 'all' ? SEARCH_ALL_GROUP_LIMIT : SEARCH_SCOPED_GROUP_LIMIT,
    sort: parsed.sort,
  };
  const inScope = (group: Exclude<SearchScope, 'all'>) => scope === 'all' || scope === group;

  const exact = await Promise.all([
    inScope('sessions') ? searchSessions(db, base) : null,
    inScope('tracks') ? searchTracks(db, { ...base, lyricsOnly: parsed.lyrics }) : null,
    inScope('playlists') ? searchPlaylists(db, base) : null,
  ]);
  const [exactSessions, exactTracks, exactPlaylists] = exact;
  // Lyrics mode answers its own miss with close lyric lines inside searchTracks.
  const close =
    !parsed.lyrics && exact.every((group) => !group?.matchCount)
      ? await closeNameMatches(
          db,
          { ownerUserId, query: parsed.q },
          (['sessions', 'tracks', 'playlists'] as const).filter(inScope),
        )
      : null;
  // A group out of scope stays null (not queried) whichever answer fills the rest.
  const sessionHits = close ? exactSessions && closeGroup(close.sessions) : exactSessions;
  const trackHits = close ? exactTracks && closeGroup(close.tracks) : exactTracks;
  const playlistHits = close ? exactPlaylists && closeGroup(close.playlists) : exactPlaylists;
  const closeMatches = close
    ? [close.sessions, close.tracks, close.playlists].some((items) => items.length > 0)
    : (exactTracks?.closeMatches ?? false);

  const sessionActivity = sessionHits
    ? await getSessionTrackActivities(db, {
        ownerUserId,
        sessionIds: sessionHits.items.map((hit) => hit.id),
      })
    : null;

  return apiOk({
    query: parsed.q,
    scope: parsed.scope,
    sort: parsed.sort,
    lyrics: parsed.lyrics,
    closeMatches,
    sessions:
      sessionHits &&
      toGroup(sessionHits, (hit) => ({
        id: hit.id,
        title: hit.title,
        coverImageId: hit.coverImageId,
        lastActiveAt: hit.lastActiveAt.toISOString(),
        status: hit.status,
        pinned: hit.pinned,
        ...(sessionActivity?.get(hit.id) ?? EMPTY_SESSION_TRACK_ACTIVITY),
        matchContext: toMatchContext(hit.match),
      })),
    tracks:
      trackHits &&
      toGroup(trackHits, (hit) => ({
        ...toLibraryTrackItem(hit),
        matchContext: toMatchContext(hit.match),
      })),
    playlists:
      playlistHits &&
      toGroup(playlistHits, (hit) => ({
        ...toPlaylistSummaryItem(hit),
        memberMatchCount: hit.memberMatchCount,
        owner: hit.owner,
        matchContext: toMatchContext(hit.match),
      })),
  });
}

/** Close matches are the whole answer, so every row found is shown. */
function closeGroup<T>(items: T[]): SearchGroup<T> {
  return { items, matchCount: items.length };
}

function toGroup<T, Item>(
  group: SearchGroup<T>,
  toItem: (hit: T) => Item,
): { items: Item[]; matchCount: number; truncated: boolean } {
  return {
    items: group.items.map(toItem),
    matchCount: group.matchCount,
    truncated: group.matchCount > group.items.length,
  };
}

/** The wire context keeps only what the row renders (exactness stays internal). */
function toMatchContext(match: SearchMatch): SearchMatchContext {
  return { field: match.field, snippet: match.snippet };
}
