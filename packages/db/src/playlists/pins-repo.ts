// Pins: a viewer's bookmark of a playlist in their Lounge,
// their own shares included — it lists first in that viewer's Lounge, newest pin
// first, one row per (viewer, playlist) pair, pure navigation. Pinning authorizes
// on the share state alone: only a playlist in the Lounge for the viewer is
// pinnable, and a refused pin (Private, outside its audience, unknown) answers
// null — the callers' uniform 404, so nothing leaks about what is hidden.
// Unpinning touches only the viewer's own row and needs no refusal. The share
// chokepoint and the playlist/user FK cascades remove pins the moment the
// playlist leaves the viewer's Lounge. A Library pin is a different thing
// (`setPlaylistLibraryPinned`): the two orders never affect each other.

import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { playlistPins, playlists } from '../schema';
import { withTransaction } from '../transactions';
import { playlistLoungeVisibleTo } from './lounge-audible';

/**
 * Pin or unpin one playlist for a viewer, idempotently. Null iff a pin was
 * asked for and the playlist is not pinnable (unknown, Private, or shared with
 * selected Users that exclude the viewer — indistinguishable by design).
 */
export async function setPlaylistLoungePinned(
  db: Database,
  args: { viewerUserId: string; playlistId: string; pinned: boolean },
): Promise<{ pinned: boolean } | null> {
  if (!args.pinned) {
    await db
      .delete(playlistPins)
      .where(
        and(
          eq(playlistPins.visitorUserId, args.viewerUserId),
          eq(playlistPins.playlistId, args.playlistId),
        ),
      );
    return { pinned: false };
  }

  // The share lock is taken in its own statement first: a share write in
  // flight holds the playlist row, so the pin waits for it, and the insert
  // that follows reads the committed share state AND audience (nothing once
  // the viewer is out); a share write that starts later waits on this lock,
  // then its purge sees the pin — no orphan window either way.
  await withTransaction(db, async (tx) => {
    await tx.execute(
      sql`select 1 from ${playlists} where ${playlists.id} = ${args.playlistId} for share`,
    );
    await tx.execute(sql`
      insert into ${playlistPins} (visitor_user_id, playlist_id)
      select ${args.viewerUserId}, ${playlists.id}
      from ${playlists}
      where ${playlists.id} = ${args.playlistId}
        and ${playlistLoungeVisibleTo(args.viewerUserId)}
      on conflict (visitor_user_id, playlist_id) do nothing
    `);
  });

  return (await isPlaylistLoungePinned(db, args)) ? { pinned: true } : null;
}

/**
 * Whether this viewer pinned this playlist — the Lounge detail's Pin toggle
 * state. The listing reads its flag off its own join.
 */
export async function isPlaylistLoungePinned(
  db: Database,
  args: { viewerUserId: string; playlistId: string },
): Promise<boolean> {
  const [row] = await db
    .select({ id: playlistPins.id })
    .from(playlistPins)
    .where(
      and(
        eq(playlistPins.visitorUserId, args.viewerUserId),
        eq(playlistPins.playlistId, args.playlistId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Pin or unpin an owned curated playlist in the owner's own Library order.
 * Idempotent: re-pinning keeps the original pin instant, so
 * the playlist keeps its place. A pin is not an edit, so `updatedAt` holds still
 * and the activity order does not move. `'not_found'` covers absent, not owned,
 * and the system playlists no list shows a pin on — indistinguishable.
 */
export async function setPlaylistLibraryPinned(
  db: Database,
  args: { ownerUserId: string; playlistId: string; pinned: boolean },
): Promise<'ok' | 'not_found'> {
  const updated = await db
    .update(playlists)
    .set({
      pinnedAt: args.pinned ? sql`coalesce(${playlists.pinnedAt}, now())` : null,
      updatedAt: sql`${playlists.updatedAt}`,
    })
    .where(
      and(
        eq(playlists.id, args.playlistId),
        eq(playlists.ownerUserId, args.ownerUserId),
        eq(playlists.kind, 'user'),
        eq(playlists.listedInPlaylists, true),
      ),
    )
    .returning({ id: playlists.id });
  return updated.length > 0 ? 'ok' : 'not_found';
}
