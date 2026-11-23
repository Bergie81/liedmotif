// The sung lines spelled most like a query, for when a lyrics search matched
// nothing: a line remembered from listening is often a letter or two off what
// the lyrics say ("mnod" for "Mond"), and a substring match then finds nothing.
// As with `closestNames`, the database only ranks by spelling and the caller
// decides whether any of them is what was meant, so there is no bar beyond
// sharing some spelling: two typos in a short line leave little in common.

import { sql } from 'drizzle-orm';
import type { Database } from '../client';
import { tracks } from '../schema';
import { searchableTracks } from './search-repo';
import { cutSnippet } from './snippet';

export type ClosestLyricLine = {
  id: string;
  /** The Track's line spelled most like the query, bounded like a search snippet. */
  line: string;
};

/**
 * The Tracks whose lyrics hold the stretch spelled most like `query`, the
 * nearest first, each with its closest line; none when no lyrics share any
 * spelling with it. Word similarity scores the query against the best-fitting
 * stretch of the whole lyrics, so a line quoted across a line break still
 * ranks; the line shown is the single one that fits best.
 */
export async function closestLyricLines(
  db: Database,
  args: { ownerUserId: string; query: string; limit: number },
): Promise<ClosestLyricLine[]> {
  const closeness = sql`word_similarity(${args.query}, ${tracks.lyrics})`;
  const result = await db.execute<ClosestLyricLine>(sql`
    with nearest as (
      select ${tracks.id} as id, ${tracks.lyrics} as lyrics,
        ${tracks.createdAt} as created_at, ${closeness} as closeness
      from ${tracks}
      where ${searchableTracks(args.ownerUserId)}
        and ${tracks.lyrics} is not null and ${closeness} > 0
      order by closeness desc, created_at desc, id asc
      limit ${args.limit}
    )
    select nearest.id,
      (select line.text
        from regexp_split_to_table(nearest.lyrics, ${'\\r?\\n'}) with ordinality as line(text, n)
        order by word_similarity(${args.query}, line.text) desc, line.n
        limit 1) as line
    from nearest
    order by nearest.closeness desc, nearest.created_at desc, nearest.id asc
  `);
  return result.rows.map((row) => ({ ...row, line: cutSnippet(row.line, args.query) }));
}
