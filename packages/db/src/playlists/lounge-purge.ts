// The revocation purge. Sharing is a revocable license: the moment
// a track stops being Lounge-audible to a visitor, that visitor's Shared
// references to it — membership rows in their playlists, which the track's
// owner does NOT own — are hard-removed in the SAME transaction as whatever
// ended the audibility; likewise their Pins of a playlist that left their
// Lounge. No suspended state, no sweeper: re-share means re-save and re-pin.
// Callers are the membership-mutating chokepoints (share write, playlist
// delete, membership removal); track delete and owner deletion already reach
// foreign rows through the global membership purge and the FK cascade.

import { sql } from 'drizzle-orm';
import type { Transaction } from '../transactions';
import { playlistPins, playlists, playlistTracks, tracks } from '../schema';
import { playlistLoungeVisibleTo, trackIsLoungeAudible } from './lounge-audible';
import { resequencePlaylistInTx } from './membership-purge';

/**
 * Purge Shared references to the candidate tracks that are no longer
 * Lounge-audible to the visitor holding them, and close the position gaps in
 * each visitor playlist that lost a row. A reference survives while its track
 * belongs to another playlist of its owner still visible to that visitor —
 * the per-visitor predicate is re-checked here rather than assumed from the
 * caller's event, so narrowing an audience purges exactly the Users it drops.
 * Exempt from the owner playlist lock discipline for the same reason as the
 * lifecycle purges: delete + resequence can leave a gap but never mint a slot
 * two rows can share.
 */
export async function purgeRevokedSharedReferencesInTx(
  tx: Transaction,
  args: { trackIds: string[] },
): Promise<void> {
  if (args.trackIds.length === 0) return;
  const removed = await tx.execute(sql`
    delete from ${playlistTracks} pt
    using ${tracks} t, ${playlists} vp
    where t.id = pt.track_id
      and vp.id = pt.playlist_id
      and pt.track_id = any(${sql.param(args.trackIds)}::uuid[])
      and vp.owner_user_id <> t.owner_user_id
      and not ${trackIsLoungeAudible(sql`vp.owner_user_id`, sql`t`)}
    returning pt.playlist_id
  `);
  const rows = (removed as unknown as { rows: Array<{ playlist_id: string }> }).rows;
  for (const playlistId of new Set(rows.map((row) => row.playlist_id))) {
    await resequencePlaylistInTx(tx, playlistId);
  }
}

/**
 * Purge the Pins of one playlist held by viewers it is no longer visible to
 * — every Pin once it is Private, the owner's own included; only the dropped
 * Users' when its audience narrows. Pins never touch membership, so there is
 * nothing to resequence. A Library pin (`playlists.pinned_at`) is no Pin: it
 * belongs to the owner's list, not the Lounge, and stays.
 */
export async function purgeRevokedPinsInTx(
  tx: Transaction,
  args: { playlistId: string },
): Promise<void> {
  await tx.execute(sql`
    delete from ${playlistPins} pin
    using ${playlists} p
    where p.id = pin.playlist_id
      and pin.playlist_id = ${args.playlistId}
      and not ${playlistLoungeVisibleTo(sql`pin.visitor_user_id`, sql`p`)}
  `);
}
