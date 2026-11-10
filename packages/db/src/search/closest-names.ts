// The names spelled most like a query, for when search matched nothing: what
// was said or typed is often one word or one sign off the name it meant ("und"
// for "&", a typo, a dropped comma). The database only ranks by spelling; the
// caller decides whether any of them is what was meant. So the bar to be
// listed is low on purpose: two swapped letters in a short name leave little
// spelling in common, and a bar high enough to keep unrelated names out would
// drop that name too.

import { sql } from 'drizzle-orm';
import type { Database } from '../client';
import { viewerCanSearchPlaylist } from '../playlists/lounge-audible';
import type { OwnerAttribution } from '../playlists/owner-attribution';
import { activitySessions, playlists, tracks } from '../schema';
import { attributeForeignPlaylists, searchableSessions, searchableTracks } from './search-repo';

/**
 * Where each kind keeps its name. `visibleTo` is the condition search itself
 * puts on that kind, so a closest name is never one search would hide.
 */
const NAMED = {
  session: {
    table: activitySessions,
    name: activitySessions.title,
    visibleTo: searchableSessions,
  },
  playlist: { table: playlists, name: playlists.name, visibleTo: viewerCanSearchPlaylist },
  track: { table: tracks, name: tracks.title, visibleTo: searchableTracks },
};

export interface ClosestName {
  id: string;
  name: string;
  /** Set only on a Lounge-pinned foreign Playlist: whose it is. */
  owner: OwnerAttribution | null;
}

/**
 * The names of one kind spelled most like `query`, the nearest first; none
 * when no name shares any spelling with it. Word similarity scores the query
 * against the best-fitting stretch of a name, so a part of a long name and a
 * name with words added around it both rank high. Names that hold the same
 * stretch tie on it, so whole-name similarity orders them: the name with the
 * least around that stretch comes first.
 */
export async function closestNames(
  db: Database,
  args: { ownerUserId: string; kind: keyof typeof NAMED; query: string; limit: number },
): Promise<ClosestName[]> {
  const { table, name, visibleTo } = NAMED[args.kind];
  const closeness = sql`word_similarity(${args.query}, ${name})`;
  const result = await db.execute<{ id: string; name: string; ownerUserId: string }>(sql`
    select ${table.id} as id, ${name} as name, ${table.ownerUserId} as "ownerUserId"
    from ${table}
    where ${visibleTo(args.ownerUserId)} and ${closeness} > 0
    order by ${closeness} desc, similarity(${args.query}, ${name}) desc,
      ${table.createdAt} desc, ${table.id} asc
    limit ${args.limit}
  `);
  const rows = await attributeForeignPlaylists(
    db,
    args.ownerUserId,
    result.rows.map((row) => ({ ...row, owner: null as OwnerAttribution | null })),
  );
  return rows.map(({ id, name: closest, owner }) => ({ id, name: closest, owner }));
}
