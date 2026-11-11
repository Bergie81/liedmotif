// The Lounge share state: whether an owned playlist is In
// Lounge, and for which audience. `setPlaylistShared` is the one write
// chokepoint — owner moderation and Admin moderation both ride it, so the
// revocation purge fires identically on every path that narrows who can see a
// playlist. A `selected` audience is never empty: the write refuses an empty
// pick, and deleting a playlist's last selected User returns it to Private.

import { and, asc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { isCuratedPlaylist, type ShareAudience } from '@liedmotif/shared';
import type { Database } from '../client';
import type { Transaction } from '../transactions';
import {
  listenerProfiles,
  playlists,
  playlistShareMembers,
  playlistTracks,
  tracks,
  user,
} from '../schema';
import { playlistLoungeVisibleTo } from './lounge-audible';
import { purgeRevokedPinsInTx, purgeRevokedSharedReferencesInTx } from './lounge-purge';
import type { LoungeOwner } from './lounge-repo';
import { ownerAttributionColumns, ownerDisplayNameOrder } from './owner-attribution';
import { lockOwnedPlaylist, withOwnerPlaylistLock } from './playlists-repo';

/** The stored share state as the contract speaks it: null iff Private. */
function toShareAudience(
  row: Pick<typeof playlists.$inferSelect, 'sharedAt' | 'shareAudience'>,
  selectedUserIds: string[],
): ShareAudience | null {
  if (row.sharedAt === null) return null;
  return row.shareAudience === 'everyone'
    ? { kind: 'everyone' }
    : { kind: 'selected', userIds: selectedUserIds };
}

/**
 * The Lounge share write: place an owned playlist In Lounge
 * for an audience — `everyone`, or exactly the `selected` Users — or return it
 * to Private (`audience` null). Only curated user playlists can be shared —
 * Favorites and unlisted collections refuse (`'system'`). A `selected` audience
 * keeps only real Users other than the owner; if none remain the write is
 * refused (`'empty_audience'`) and nothing changes — an empty audience is
 * Private, which the caller asks for explicitly.
 *
 * `sharedAt` is set on the first share and kept through every audience change
 * (it is the Lounge's newest-first sort key, so it must not bump); Private
 * resets the audience, so nothing is remembered for a later re-share.
 * `updatedAt` stays untouched — share state is visibility, not a content
 * change, so the Playlists tab's activity order must not move.
 *
 * Any change to a shared playlist runs the revocation purge in this same
 * transaction: Shared references and Pins held by Users who can no longer see
 * it go now — on unshare everyone's, on a narrowed audience exactly the
 * dropped Users'.
 */
export async function setPlaylistShared(
  db: Database,
  args: {
    ownerUserId: string;
    playlistId: string;
    audience: ShareAudience | null;
    now?: Date;
    /** Act only while the playlist is in the Lounge for this User (Admin moderation). */
    visibleTo?: string;
  },
): Promise<
  { sharedAt: Date | null; audience: ShareAudience | null } | 'system' | 'empty_audience' | null
> {
  return withOwnerPlaylistLock(db, args.ownerUserId, async (tx) => {
    const playlist = await lockOwnedPlaylist(tx, args.ownerUserId, args.playlistId);
    if (!playlist) return null;
    if (!isCuratedPlaylist(playlist)) return 'system';
    if (args.visibleTo !== undefined) {
      const [visible] = await tx
        .select({ id: playlists.id })
        .from(playlists)
        .where(and(eq(playlists.id, playlist.id), playlistLoungeVisibleTo(args.visibleTo)))
        .limit(1);
      if (!visible) return null;
    }

    const audience = args.audience;
    if (audience === null && playlist.sharedAt === null) return { sharedAt: null, audience: null };

    let selectedUserIds: string[] = [];
    if (audience?.kind === 'selected') {
      selectedUserIds = await validSelectedUserIds(tx, args.ownerUserId, audience.userIds);
      if (selectedUserIds.length === 0) return 'empty_audience';
    }

    const next = {
      sharedAt: audience === null ? null : (playlist.sharedAt ?? args.now ?? new Date()),
      shareAudience: audience?.kind ?? 'everyone',
    } as const;
    await tx
      .update(playlists)
      .set({ ...next, updatedAt: sql`${playlists.updatedAt}` })
      .where(eq(playlists.id, playlist.id));
    await tx.delete(playlistShareMembers).where(eq(playlistShareMembers.playlistId, playlist.id));
    if (selectedUserIds.length > 0) {
      await tx
        .insert(playlistShareMembers)
        .values(selectedUserIds.map((userId) => ({ playlistId: playlist.id, userId })));
    }

    if (playlist.sharedAt !== null) {
      const members = await tx
        .select({ trackId: playlistTracks.trackId })
        .from(playlistTracks)
        .where(eq(playlistTracks.playlistId, playlist.id));
      const trackIds = [...new Set(members.map((m) => m.trackId))];
      // The Shared-reference save locks its track row, so holding the owned
      // members' locks makes a save in flight either commit before this purge
      // reads, or wait and then see the revocation.
      if (trackIds.length > 0) {
        await tx
          .select({ id: tracks.id })
          .from(tracks)
          .where(and(inArray(tracks.id, trackIds), eq(tracks.ownerUserId, args.ownerUserId)))
          .orderBy(asc(tracks.id))
          .for('update');
      }
      await purgeRevokedSharedReferencesInTx(tx, { trackIds });
      await purgeRevokedPinsInTx(tx, { playlistId: playlist.id });
    }

    return { sharedAt: next.sharedAt, audience: toShareAudience(next, selectedUserIds) };
  });
}

/**
 * The picked ids that name a real User other than the owner, deduplicated and
 * sorted. The key-share locks hold those Users until commit, so the audience
 * insert cannot race a User delete into a foreign-key failure.
 */
async function validSelectedUserIds(
  tx: Transaction,
  ownerUserId: string,
  userIds: string[],
): Promise<string[]> {
  const rows = await tx
    .select({ id: user.id })
    .from(user)
    .where(and(inArray(user.id, [...new Set(userIds)]), ne(user.id, ownerUserId)))
    .orderBy(asc(user.id))
    .for('key share');
  return rows.map((row) => row.id);
}

/** The share picker's read: the playlist's current audience and who could be in it. */
export interface PlaylistShareState {
  /** Null iff Private. */
  audience: ShareAudience | null;
  /** Every User other than the owner, display-name ordered. */
  candidates: LoungeOwner[];
}

/**
 * The owner's share picker state for one playlist. Owner-scoped: a cross-owner
 * or unknown id answers null (the uniform 404). Candidates carry the owner
 * attribution vocabulary and never an email.
 */
export async function getPlaylistShare(
  db: Database,
  args: { ownerUserId: string; playlistId: string },
): Promise<PlaylistShareState | null> {
  const [playlist] = await db
    .select({ sharedAt: playlists.sharedAt, shareAudience: playlists.shareAudience })
    .from(playlists)
    .where(and(eq(playlists.id, args.playlistId), eq(playlists.ownerUserId, args.ownerUserId)))
    .limit(1);
  if (!playlist) return null;

  const selected =
    playlist.sharedAt !== null && playlist.shareAudience === 'selected'
      ? await db
          .select({ userId: playlistShareMembers.userId })
          .from(playlistShareMembers)
          .where(eq(playlistShareMembers.playlistId, args.playlistId))
          .orderBy(asc(playlistShareMembers.userId))
      : [];

  const candidates = await db
    .select({ userId: user.id, ...ownerAttributionColumns() })
    .from(user)
    .leftJoin(listenerProfiles, eq(listenerProfiles.ownerUserId, user.id))
    .where(ne(user.id, args.ownerUserId))
    .orderBy(...ownerDisplayNameOrder());
  return {
    audience: toShareAudience(
      playlist,
      selected.map((row) => row.userId),
    ),
    candidates,
  };
}

/**
 * Admin moderation: the single cross-owner write. Resolves the
 * owner of a playlist currently in the Lounge FOR THE ADMIN, then rides the
 * owner's own unshare chokepoint (`setPlaylistShared`), so the full revocation
 * purge — Shared references and Pins — fires identically, in one transaction.
 * A playlist the Admin cannot see (Private, or shared with selected Users that
 * exclude them) answers `null` exactly like an unknown one, so moderation can
 * never probe what is hidden from them. The owner keeps the playlist and
 * everything in it, and may re-share at will.
 */
export async function moderateLoungePlaylistToPrivate(
  db: Database,
  args: { adminUserId: string; playlistId: string },
): Promise<'private' | null> {
  const [shared] = await db
    .select({ ownerUserId: playlists.ownerUserId })
    .from(playlists)
    .where(and(eq(playlists.id, args.playlistId), playlistLoungeVisibleTo(args.adminUserId)))
    .limit(1);
  if (!shared) return null;
  // The unshare re-checks visibility under the row lock, so a concurrent
  // owner-side unshare, delete, or audience narrowing that drops the Admin
  // degrades to the uniform null.
  const result = await setPlaylistShared(db, {
    ownerUserId: shared.ownerUserId,
    playlistId: args.playlistId,
    audience: null,
    visibleTo: args.adminUserId,
  });
  return result === null || typeof result === 'string' ? null : 'private';
}

/**
 * Row-lock the playlists whose `selected` audience names `userId` — call it
 * before deleting that User, then `returnEmptySelectedAudiencesToPrivateInTx`
 * after the cascade. Locking playlist before User is the share write's own
 * order, so the delete cannot deadlock against an audience change in flight.
 */
export async function lockSelectedAudiencesNamingInTx(
  tx: Transaction,
  userId: string,
): Promise<void> {
  await tx
    .select({ id: playlists.id })
    .from(playlists)
    .innerJoin(playlistShareMembers, eq(playlistShareMembers.playlistId, playlists.id))
    .where(eq(playlistShareMembers.userId, userId))
    .orderBy(asc(playlists.id))
    .for('update', { of: playlists });
}

/**
 * Return to Private every shared `selected` playlist left with no selected
 * User — an empty audience is Private by definition, never a stored state.
 * Instance-wide rather than limited to the playlists locked beforehand, so an
 * audience that gained the deleted User after that lock (the share committing
 * while the delete waited on the User row) is caught too. Nobody but the owner
 * could see such a playlist, so the owner's own Pin is the only thing to purge.
 */
export async function returnEmptySelectedAudiencesToPrivateInTx(tx: Transaction): Promise<void> {
  const returned = await tx
    .update(playlists)
    .set({ sharedAt: null, shareAudience: 'everyone', updatedAt: sql`${playlists.updatedAt}` })
    .where(
      and(
        isNotNull(playlists.sharedAt),
        eq(playlists.shareAudience, 'selected'),
        sql`not exists(
          select 1 from ${playlistShareMembers} psm where psm.playlist_id = ${playlists}."id"
        )`,
      ),
    )
    .returning({ id: playlists.id });
  for (const { id } of returned) {
    await purgeRevokedPinsInTx(tx, { playlistId: id });
  }
}
