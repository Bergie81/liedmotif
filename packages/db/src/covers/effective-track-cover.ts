import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/** A Session Cover is shared by its Tracks; Track art is only the fallback for
 * Session-less legacy rows. Keep every Track-list surface on this precedence. */
export function effectiveTrackCoverColumn(
  sessionCover: SQLWrapper,
  trackCover: SQLWrapper,
): SQL<string | null> {
  return sql<string | null>`coalesce(${sessionCover}, ${trackCover})`;
}
