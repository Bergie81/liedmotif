// GET /api/search — ranked, capped retrieval across Sessions, Tracks and
// Playlists. Read-only: no provider call, no LLM call, no write.
// The caps are server-fixed (5 per group under All, 50 on a scope tab); a
// client cannot ask for more, and there is no cursor to page with.

import { NextResponse } from 'next/server';
import {
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
import { apiOk, requireOwnerId, validateInput } from '@/lib/api-response';
import { getDb } from '@/lib/db';
import { toPlaylistSummaryItem } from '@/lib/playlists';
import { toLibraryTrackItem } from '@/lib/tracks';

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

  const [sessionHits, trackHits, playlistHits] = await Promise.all([
    inScope('sessions') ? searchSessions(db, base) : null,
    inScope('tracks') ? searchTracks(db, { ...base, lyricsOnly: parsed.lyrics }) : null,
    inScope('playlists') ? searchPlaylists(db, base) : null,
  ]);

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
