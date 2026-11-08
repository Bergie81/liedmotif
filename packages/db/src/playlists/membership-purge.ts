// Low-level playlist-membership writes shared between the playlists repo and
// the track lifecycle paths (Dislike reject / Delete Track), kept separate so
// `feedback-repo` / `delete-track-repo` can purge memberships without importing
// the playlists repo (which imports feedback-repo for its read columns).

import { eq, sql } from 'drizzle-orm';
import type { Transaction } from '../transactions';
import { playlistTracks } from '../schema';

/** Rewrite a playlist's positions to a dense 0..n-1 run (stable on current order). */
export async function resequencePlaylistInTx(tx: Transaction, playlistId: string): Promise<void> {
  await tx.execute(sql`
    update ${playlistTracks} pt
    set position = ranked.rn - 1
    from (
      select id, row_number() over (order by position, created_at, id) as rn
      from ${playlistTracks}
      where playlist_id = ${playlistId}
    ) ranked
    where pt.id = ranked.id and pt.position <> ranked.rn - 1
  `);
}

/**
 * Write an explicit order: `rowIds` are membership row ids, and take positions
 * 0..n-1 in the order given. One statement — the caller holds the playlist lock
 * across it, so a per-row update would pin the connection for as many round
 * trips as the playlist has tracks.
 */
export async function applyPlaylistOrderInTx(tx: Transaction, rowIds: string[]): Promise<void> {
  await tx.execute(sql`
    update ${playlistTracks} pt
    set position = ordered.rn - 1
    from unnest(${sql.param(rowIds)}::uuid[]) with ordinality as ordered(id, rn)
    where pt.id = ordered.id and pt.position <> ordered.rn - 1
  `);
}

/**
 * Remove a track from EVERY playlist (the Dislike/Delete lifecycle purge — a
 * rejected/deleted track must not linger in curation surfaces) and close the
 * position gaps. Callers own the matching retention-flag clear on the track row
 * in the same transaction.
 */
export async function purgeTrackMembershipsInTx(tx: Transaction, trackId: string): Promise<void> {
  const removed = await tx
    .delete(playlistTracks)
    .where(eq(playlistTracks.trackId, trackId))
    .returning({ playlistId: playlistTracks.playlistId });
  for (const playlistId of new Set(removed.map((r) => r.playlistId))) {
    await resequencePlaylistInTx(tx, playlistId);
  }
}
