// What a Search answers when its exact words found nothing: the Sessions,
// Tracks and Playlists whose names are spelled most like the query, closest
// first, as the same rows exact search returns. `closestNames` decides what is
// close and what the viewer may see; this only loads its picks as rows.

import type { Database } from '../client';
import { closestNames, type ClosestName } from './closest-names';
import {
  CLOSE_MATCH_EXACTNESS,
  CLOSE_MATCH_LIMIT,
  closePlaylistHits,
  closeSessionHits,
  closeTrackHits,
  type SearchMatch,
  type SearchPlaylistHit,
  type SearchSessionHit,
  type SearchTrackHit,
} from './search-repo';

export type CloseNameKind = 'sessions' | 'tracks' | 'playlists';

/** One list per kind, closest first; empty for a kind not asked for. */
export interface CloseNameGroups {
  sessions: SearchSessionHit[];
  tracks: SearchTrackHit[];
  playlists: SearchPlaylistHit[];
}

export async function closeNameMatches(
  db: Database,
  args: { ownerUserId: string; query: string },
  kinds: readonly CloseNameKind[],
): Promise<CloseNameGroups> {
  const { ownerUserId, query } = args;
  const closest = (kind: 'session' | 'track' | 'playlist') =>
    closestNames(db, { ownerUserId, kind, query, limit: CLOSE_MATCH_LIMIT });
  const [sessions, tracks, playlists] = await Promise.all([
    kinds.includes('sessions')
      ? closest('session').then((found) => closeSessionHits(db, ownerUserId, found, nameMatch))
      : [],
    kinds.includes('tracks')
      ? closest('track').then((found) => closeTrackHits(db, ownerUserId, found, nameMatch))
      : [],
    kinds.includes('playlists')
      ? closest('playlist').then((found) => closePlaylistHits(db, ownerUserId, found, nameMatch))
      : [],
  ]);
  return { sessions, tracks, playlists };
}

function nameMatch(found: ClosestName): SearchMatch {
  return { field: 'name', exactness: CLOSE_MATCH_EXACTNESS, snippet: found.name };
}
