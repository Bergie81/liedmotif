// Playlists repo. The ONLY module
// that writes `playlist_tracks` — every membership mutation runs here in one
// transaction that also re-derives the denormalized `tracks.savedAt` /
// `favoritedAt` flags and appends the retention audit rows, so the invariant
// (savedAt <=> member of >=1 playlist; favoritedAt <=> member of Favorites)
// can never be observed half-applied. All reads/writes are owner-scoped: a
// cross-owner id is indistinguishable from a missing one (the 404 IDOR posture).
//
// LOCK DISCIPLINE: every write here that touches `playlist_tracks` runs under
// `withOwnerPlaylistLock` — see that helper for why, and take it in any new one.

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  deriveTrackRetentionClass,
  isCuratedPlaylist,
  MAX_PLAYLIST_NAME_LENGTH,
  type TrackStatus,
} from '@liedmotif/shared';
import { recordTasteEvidenceInTx } from '../analytics/taste-repo';
import { OWNER_PLAYLIST_LOCK_CLASS } from '../advisory-locks';
import type { Database } from '../client';
import { withTransaction, type Transaction } from '../transactions';
import {
  activitySessions,
  feedbackEvents,
  playlists,
  playlistTracks,
  sessionCoverGenerations,
  tracks,
} from '../schema';
import { type TrackFlagWriteResult } from '../generation/feedback-repo';
import { evictOrphanedTracksInTx } from '../generation/eviction-repo';
import { sessionNotPendingDelete } from '../generation/session-list-repo';
import { listPlayableSessionTrackIds } from '../generation/session-tracks-repo';
import { playlistLedgerSubject } from '../covers/generation-ledger-repo';
import {
  deleteUnreferencedCoverRows,
  listSubjectCoverImageIds,
  queueCoverFileDeletions,
} from '../covers/cover-reclaim';
import {
  applyPlaylistOrderInTx,
  purgeTrackMembershipsInTx,
  resequencePlaylistInTx,
} from './membership-purge';
import { viewerCanReadTrack } from './lounge-audible';
import { purgeRevokedSharedReferencesInTx } from './lounge-purge';

/** The fixed display name of the per-owner Favorites system playlist. */
export const FAVORITES_PLAYLIST_NAME = 'Favorites';

export interface PlaylistRow {
  id: string;
  ownerUserId: string;
  name: string;
  kind: 'user' | 'favorites';
  listedInPlaylists: boolean;
  coverImageId: string | null;
  lastPlayedAt: Date | null;
  /** The Lounge share state: null = Private, set = In Lounge. */
  sharedAt: Date | null;
  /** The owner's Library pin: set = first in their Playlists tab, newest pin
   *  first. Only the owner's list and detail reads carry it. */
  pinnedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Get-or-create the owner's Favorites system playlist. Idempotent under
 * concurrency: the insert races on the partial unique index and loses silently,
 * then reads the winner.
 */
export async function ensureFavoritesPlaylist(
  db: Database | Transaction,
  args: { ownerUserId: string },
): Promise<PlaylistRow> {
  const [existing] = await db
    .select()
    .from(playlists)
    .where(and(eq(playlists.ownerUserId, args.ownerUserId), eq(playlists.kind, 'favorites')))
    .limit(1);
  if (existing) return existing;

  const [inserted] = await db
    .insert(playlists)
    .values({
      ownerUserId: args.ownerUserId,
      name: FAVORITES_PLAYLIST_NAME,
      kind: 'favorites',
      listedInPlaylists: false,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;

  const [raced] = await db
    .select()
    .from(playlists)
    .where(and(eq(playlists.ownerUserId, args.ownerUserId), eq(playlists.kind, 'favorites')))
    .limit(1);
  return raced!;
}

/** Create an ordinary user playlist. */
export async function createPlaylist(
  db: Database | Transaction,
  args: { ownerUserId: string; name: string },
): Promise<PlaylistRow> {
  // The Playlists tab's keyset cursor carries the activity time at JavaScript
  // precision, so a JS write keeps it exact; the column default is microseconds.
  const [row] = await db
    .insert(playlists)
    .values({ ownerUserId: args.ownerUserId, name: args.name, kind: 'user', updatedAt: new Date() })
    .returning();
  return row!;
}

/**
 * Run a membership write in a transaction holding the owner's BLOCKING playlist
 * advisory lock. Append slots are `max(position) + 1` computed in application
 * code and `(playlistId, position)` is non-unique, so two writers that overlap
 * hand the same slot to two different tracks — and because the detail read
 * keysets on `position`, a duplicated slot is returned by no page at all: a real
 * membership becomes unreachable in the UI. This lock is also taken before any
 * row lock, so the writers that reach `playlists` and `tracks` from opposite
 * ends can no longer interleave into a deadlock. Transaction-scoped
 * (auto-released on commit/rollback) and per owner, whose own playlists are the
 * only rows any of these writes can reach.
 *
 * The lifecycle purge paths (`membership-purge`, used by Dislike/Delete Track)
 * are deliberately exempt: they only delete and resequence, which can leave a
 * gap but never mint a slot two rows can share.
 */
export async function withOwnerPlaylistLock<T>(
  db: Database,
  ownerUserId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withTransaction(db, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNER_PLAYLIST_LOCK_CLASS}, hashtext(${ownerUserId}))`,
    );
    return fn(tx);
  });
}

/** The append slot: one past the playlist's current highest position. */
async function nextPlaylistPosition(tx: Transaction, playlistId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number>`coalesce(max(${playlistTracks.position}), -1)::int` })
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, playlistId));
  return (row?.max ?? -1) + 1;
}

/**
 * Load + row-lock an owned playlist. The lock serializes all membership/position
 * math per playlist; null = absent or not owned (the 404 IDOR posture).
 */
export async function lockOwnedPlaylist(
  tx: Transaction,
  ownerUserId: string,
  playlistId: string,
): Promise<PlaylistRow | null> {
  const [row] = await tx
    .select()
    .from(playlists)
    .where(and(eq(playlists.id, playlistId), eq(playlists.ownerUserId, ownerUserId)))
    .limit(1)
    .for('update');
  return row ?? null;
}

/**
 * Re-derive the denormalized retention flags for the given tracks from their
 * live memberships — THE retention chokepoint (savedAt <=> >=1 membership;
 * favoritedAt <=> Favorites membership). Appends `feedback_events` audit rows
 * only for flags that actually flip. Callers must already hold the track row
 * locks (`FOR UPDATE`, id-ordered) so the derivation is atomic with their
 * membership writes.
 */
async function syncTrackFlagsInTx(
  tx: Transaction,
  args: { ownerUserId: string; trackIds: string[]; now: Date },
): Promise<{ evictedTrackIds: string[] }> {
  if (args.trackIds.length === 0) return { evictedTrackIds: [] };
  const flagRows = await tx
    .select({ id: tracks.id, savedAt: tracks.savedAt, favoritedAt: tracks.favoritedAt })
    .from(tracks)
    .where(and(inArray(tracks.id, args.trackIds), eq(tracks.ownerUserId, args.ownerUserId)));
  const membership = await tx
    .select({
      trackId: playlistTracks.trackId,
      total: sql<number>`count(*)::int`,
      favorites: sql<number>`count(*) filter (where ${playlists.kind} = 'favorites')::int`,
    })
    .from(playlistTracks)
    .innerJoin(playlists, eq(playlists.id, playlistTracks.playlistId))
    .where(
      and(
        inArray(playlistTracks.trackId, args.trackIds),
        eq(playlists.ownerUserId, args.ownerUserId),
      ),
    )
    .groupBy(playlistTracks.trackId);
  const byTrack = new Map(membership.map((m) => [m.trackId, m]));

  const turnedEphemeral: string[] = [];
  for (const row of flagRows) {
    const counts = byTrack.get(row.id);
    const savedAt = (counts?.total ?? 0) > 0 ? (row.savedAt ?? args.now) : null;
    const favoritedAt = (counts?.favorites ?? 0) > 0 ? (row.favoritedAt ?? args.now) : null;
    // Only tracks THIS mutation turned Ephemeral: one already unsaved before it
    // cannot have just orphaned, and re-checking it would make every membership
    // write O(n) in bystanders.
    if (!savedAt && !favoritedAt && (row.savedAt || row.favoritedAt)) turnedEphemeral.push(row.id);
    const audits: Array<'save' | 'unsave' | 'favorite' | 'unfavorite'> = [];
    if (!row.savedAt !== !savedAt) audits.push(savedAt ? 'save' : 'unsave');
    if (!row.favoritedAt !== !favoritedAt) audits.push(favoritedAt ? 'favorite' : 'unfavorite');
    if (audits.length === 0) continue;

    await tx.update(tracks).set({ savedAt, favoritedAt }).where(eq(tracks.id, row.id));
    await recordTasteEvidenceInTx(tx, {
      ownerUserId: args.ownerUserId,
      trackId: row.id,
      kind: favoritedAt ? 'favorite' : savedAt ? 'playlist' : null,
      gained: audits.includes('save') || audits.includes('favorite'),
    });
    await tx.insert(feedbackEvents).values(
      audits.map((feedbackType) => ({
        userId: args.ownerUserId,
        trackId: row.id,
        feedbackType,
      })),
    );
  }

  // The orphan rule: a track that ends the mutation
  // Ephemeral AND whose originating session is gone has no surface left that
  // can reach it — reclaim it in the same commit as the membership loss.
  return evictOrphanedTracksInTx(tx, { trackIds: turnedEphemeral, now: args.now });
}

/**
 * Lock (id-ordered, deadlock-safe) the owner's candidate tracks, with their status.
 */
async function lockOwnTracks(
  tx: Transaction,
  ownerUserId: string,
  trackIds: string[],
): Promise<Array<{ id: string; status: TrackStatus }>> {
  if (trackIds.length === 0) return [];
  return tx
    .select({ id: tracks.id, status: tracks.status })
    .from(tracks)
    .where(and(inArray(tracks.id, trackIds), eq(tracks.ownerUserId, ownerUserId)))
    .orderBy(asc(tracks.id))
    .for('update');
}

/**
 * Why a Track cannot be newly filed: `removed` (rejected or deleted), `failed`
 * (a failed Track holds no audio worth keeping: it stays where it was filed,
 * but is never filed anew), or null when it can.
 */
function refusalOf(status: TrackStatus): 'removed' | 'failed' | null {
  if (status === 'rejected' || status === 'deleted') return 'removed';
  if (status === 'failed') return 'failed';
  return null;
}

/**
 * Lock and classify the owner's candidate tracks: only surviving owned tracks
 * are eligible for membership; everything else is refused.
 */
async function lockEligibleTracks(
  tx: Transaction,
  ownerUserId: string,
  trackIds: string[],
): Promise<Set<string>> {
  const rows = await lockOwnTracks(tx, ownerUserId, trackIds);
  return new Set(rows.filter((r) => refusalOf(r.status) === null).map((r) => r.id));
}

type AddRefusal = 'removed' | 'failed' | 'notFound';

/**
 * The add-many write's classification, under the same locks: null = addable,
 * else why not. Own tracks only, unless `includeLoungeTracks`: then each track
 * goes through the picker commit's own check, in id order, so a foreign track
 * the viewer cannot hear is as not found as an unknown id.
 */
async function lockAddableTracks(
  tx: Transaction,
  ownerUserId: string,
  trackIds: string[],
  includeLoungeTracks: boolean,
): Promise<Map<string, AddRefusal | null>> {
  const verdicts = new Map<string, AddRefusal | null>(trackIds.map((id) => [id, 'notFound']));
  if (!includeLoungeTracks) {
    for (const row of await lockOwnTracks(tx, ownerUserId, trackIds)) {
      verdicts.set(row.id, refusalOf(row.status));
    }
    return verdicts;
  }
  for (const id of [...trackIds].sort()) {
    const track = await lockSaveableTrack(tx, ownerUserId, id);
    if (track === null) continue;
    verdicts.set(id, track === 'removed' ? 'removed' : refusalOf(track.status));
  }
  return verdicts;
}

export interface AddPlaylistTracksResult {
  /** Track ids newly appended (in request order). */
  added: string[];
  /** Track ids not added, for any of the causes below (request order). */
  refused: string[];
  /** Refused because the track was rejected (Disliked) or deleted. */
  removed: string[];
  /** Refused because the track failed to generate. */
  failed: string[];
  /** Refused because the track is unknown, or not one the caller may file. */
  notFound: string[];
}

/**
 * Append tracks to an owned playlist (in request order). Idempotent per track —
 * an existing member is silently kept (no duplicate, no audit). Membership
 * implies Save (and Favorite for the Favorites playlist): flags + audits are
 * derived in the same transaction. Add-only: no other membership is touched.
 * `includeLoungeTracks` also files foreign Lounge-audible tracks, as Shared
 * references that flip none of the owner's flags (`syncTrackFlagsInTx` counts
 * owner memberships only). Null when the playlist is absent/not owned.
 */
export async function addPlaylistTracks(
  db: Database,
  args: {
    ownerUserId: string;
    playlistId: string;
    trackIds: string[];
    includeLoungeTracks?: boolean;
    now?: Date;
  },
): Promise<AddPlaylistTracksResult | null> {
  const now = args.now ?? new Date();
  // Postgres reads a uuid in any letter case; the membership check compares
  // strings, so ids are matched in the lowercase form the rows come back in.
  const requested = [...new Set(args.trackIds.map((id) => id.toLowerCase()))];
  return withOwnerPlaylistLock(db, args.ownerUserId, async (tx) => {
    const playlist = await lockOwnedPlaylist(tx, args.ownerUserId, args.playlistId);
    if (!playlist) return null;

    const verdicts = await lockAddableTracks(
      tx,
      args.ownerUserId,
      requested,
      args.includeLoungeTracks ?? false,
    );
    const refusedFor = (cause: AddRefusal) => requested.filter((id) => verdicts.get(id) === cause);

    const existing = await tx
      .select({ trackId: playlistTracks.trackId })
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, playlist.id));
    const members = new Set(existing.map((r) => r.trackId));
    const toAdd = requested.filter((id) => verdicts.get(id) === null && !members.has(id));

    if (toAdd.length > 0) {
      const nextPosition = await nextPlaylistPosition(tx, playlist.id);
      await tx.insert(playlistTracks).values(
        toAdd.map((trackId, i) => ({
          playlistId: playlist.id,
          trackId,
          position: nextPosition + i,
        })),
      );
      await tx.update(playlists).set({ updatedAt: now }).where(eq(playlists.id, playlist.id));
      await syncTrackFlagsInTx(tx, { ownerUserId: args.ownerUserId, trackIds: toAdd, now });
    }
    return {
      added: toAdd,
      refused: requested.filter((id) => verdicts.get(id) !== null),
      removed: refusedFor('removed'),
      failed: refusedFor('failed'),
      notFound: refusedFor('notFound'),
    };
  });
}

export type ConvertSessionToPlaylistResult =
  | { ok: true; playlistId: string; trackCount: number }
  | { ok: false; reason: 'not_found' | 'no_tracks' };

/**
 * File a Session's listed Tracks, in list order, into a new `user` Playlist named
 * after it — all or nothing, so a failure leaves no empty Playlist behind. The
 * Session itself is left as it is; the Tracks become Durable through the same
 * flag chokepoint as every other membership write. Each call mints its own
 * Playlist, under a name that may repeat.
 */
export async function convertSessionToPlaylist(
  db: Database,
  args: { ownerUserId: string; sessionId: string; now?: Date },
): Promise<ConvertSessionToPlaylistResult> {
  const now = args.now ?? new Date();
  return withOwnerPlaylistLock(db, args.ownerUserId, async (tx) => {
    const [session] = await tx
      .select({ title: activitySessions.title })
      .from(activitySessions)
      .where(
        and(
          eq(activitySessions.id, args.sessionId),
          eq(activitySessions.ownerUserId, args.ownerUserId),
          sessionNotPendingDelete(),
        ),
      );
    if (!session) return { ok: false, reason: 'not_found' };

    const listed = await listPlayableSessionTrackIds(tx, args);
    const eligible = await lockEligibleTracks(tx, args.ownerUserId, listed);
    const trackIds = listed.filter((id) => eligible.has(id));
    if (trackIds.length === 0) return { ok: false, reason: 'no_tracks' };

    const playlist = await createPlaylist(tx, {
      ownerUserId: args.ownerUserId,
      name: playlistNameForSession(session.title),
    });
    await tx
      .insert(playlistTracks)
      .values(
        trackIds.map((trackId, position) => ({ playlistId: playlist.id, trackId, position })),
      );
    await syncTrackFlagsInTx(tx, { ownerUserId: args.ownerUserId, trackIds, now });
    return { ok: true, playlistId: playlist.id, trackCount: trackIds.length };
  });
}

function playlistNameForSession(title: string | null): string {
  const name = title?.trim() || 'Untitled Session';
  return name.slice(0, MAX_PLAYLIST_NAME_LENGTH).trimEnd();
}

/**
 * Remove a track from an owned playlist. Resequences the remaining positions and
 * re-derives the track's retention flags — removal from its LAST playlist
 * returns it to Ephemeral (unsave); removal from Favorites unfavorites. Null
 * when the playlist is absent/not owned; `removed: false` when the track was
 * not a member (a no-op, not an error).
 */
export async function removePlaylistTrack(
  db: Database,
  args: { ownerUserId: string; playlistId: string; trackId: string; now?: Date },
): Promise<{ removed: boolean; unsaved: boolean; deletedForGood: boolean } | null> {
  const now = args.now ?? new Date();
  return withOwnerPlaylistLock(db, args.ownerUserId, async (tx) => {
    const playlist = await lockOwnedPlaylist(tx, args.ownerUserId, args.playlistId);
    if (!playlist) return null;

    await lockEligibleTracks(tx, args.ownerUserId, [args.trackId]);
    const deleted = await tx
      .delete(playlistTracks)
      .where(
        and(eq(playlistTracks.playlistId, playlist.id), eq(playlistTracks.trackId, args.trackId)),
      )
      .returning({ id: playlistTracks.id });
    if (deleted.length === 0) return { removed: false, unsaved: false, deletedForGood: false };

    await resequencePlaylistInTx(tx, playlist.id);
    // Leaving an In-Lounge playlist can end the track's audibility:
    // the reference purge re-checks the predicate and reaches only tracks with
    // no other sharing playlist.
    if (playlist.sharedAt) {
      await purgeRevokedSharedReferencesInTx(tx, { trackIds: [args.trackId] });
    }
    await tx.update(playlists).set({ updatedAt: now }).where(eq(playlists.id, playlist.id));
    const { evictedTrackIds } = await syncTrackFlagsInTx(tx, {
      ownerUserId: args.ownerUserId,
      trackIds: [args.trackId],
      now,
    });
    // Whether this was the track's LAST playlist — the caller's cue to say
    // "removed from your Library", not just "removed from this playlist". For
    // a Shared reference the question is about the CALLER's library: the
    // foreign track row carries the owner's flags, which must not mask the
    // visitor's exit (shelves are always viewer-relative).
    const [trackRow] = await tx
      .select({ ownerUserId: tracks.ownerUserId })
      .from(tracks)
      .where(eq(tracks.id, args.trackId))
      .limit(1);
    const flags =
      trackRow && trackRow.ownerUserId !== args.ownerUserId
        ? await readViewerReferenceFlagsInTx(tx, args.ownerUserId, args.trackId)
        : await readTrackFlagsInTx(tx, args.trackId);
    return {
      removed: true,
      unsaved: flags.savedAt === null,
      // Its Session was gone, so no History holds it either.
      deletedForGood: evictedTrackIds.length > 0,
    };
  });
}

/**
 * Replace the playlist order with `trackIds` and resequence densely. The list
 * must be exactly the current membership, once each: the reorder UI commits a
 * whole order in one write, so anything else means the client is working from a
 * membership that has since changed. Null when the playlist is absent/not
 * owned, `'stale'` for a list that is not that membership.
 */
export async function setPlaylistOrder(
  db: Database,
  args: { ownerUserId: string; playlistId: string; trackIds: string[]; now?: Date },
): Promise<{ trackIds: string[] } | 'stale' | null> {
  const now = args.now ?? new Date();
  return withOwnerPlaylistLock(db, args.ownerUserId, async (tx) => {
    const playlist = await lockOwnedPlaylist(tx, args.ownerUserId, args.playlistId);
    if (!playlist) return null;

    const members = await tx
      .select({ id: playlistTracks.id, trackId: playlistTracks.trackId })
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, playlist.id))
      .orderBy(asc(playlistTracks.position), asc(playlistTracks.createdAt), asc(playlistTracks.id));

    if (args.trackIds.length !== members.length) return 'stale';
    const rowByTrackId = new Map(members.map((member) => [member.trackId, member.id]));
    const ordered: string[] = [];
    for (const trackId of args.trackIds) {
      const rowId = rowByTrackId.get(trackId);
      // A repeat consumes the row it names, so a duplicate misses on its second
      // pass — length plus this check together prove a permutation.
      if (!rowId) return 'stale';
      rowByTrackId.delete(trackId);
      ordered.push(rowId);
    }

    const unchanged = members.every((member, index) => member.trackId === args.trackIds[index]);
    if (!unchanged) {
      await applyPlaylistOrderInTx(tx, ordered);
      await tx.update(playlists).set({ updatedAt: now }).where(eq(playlists.id, playlist.id));
    }
    return { trackIds: args.trackIds };
  });
}

/**
 * Lock one owned track for a retention write. Returns the row, `'removed'` for
 * a rejected/deleted track (no longer flaggable — routes map it to 409), or
 * null when absent/not owned.
 */
async function lockTrackForRetention(
  tx: Transaction,
  ownerUserId: string,
  trackId: string,
): Promise<{ id: string } | 'removed' | null> {
  const [track] = await tx
    .select({ id: tracks.id, status: tracks.status })
    .from(tracks)
    .where(and(eq(tracks.id, trackId), eq(tracks.ownerUserId, ownerUserId)))
    .limit(1)
    .for('update');
  if (!track) return null;
  if (track.status === 'rejected' || track.status === 'deleted') return 'removed';
  return { id: track.id };
}

/**
 * Lock one track a viewer may FILE into their own playlists: their own, or a
 * foreign Lounge-audible one — the Shared-reference save hangs on
 * the same predicate as every other visitor read. Returns the row (with its
 * owner, so callers know a reference from an own track), `'removed'` for a
 * rejected/deleted track, null when absent or not audible — indistinguishable
 * (the uniform 404).
 */
async function lockSaveableTrack(
  tx: Transaction,
  viewerUserId: string,
  trackId: string,
): Promise<{ id: string; ownerUserId: string; status: TrackStatus } | 'removed' | null> {
  const [track] = await tx
    .select({ id: tracks.id, status: tracks.status, ownerUserId: tracks.ownerUserId })
    .from(tracks)
    .where(and(eq(tracks.id, trackId), viewerCanReadTrack(viewerUserId)))
    .limit(1)
    .for('update');
  if (!track) return null;
  if (track.status === 'rejected' || track.status === 'deleted') return 'removed';
  if (track.ownerUserId !== viewerUserId) {
    // A revoking write holds this row lock until it commits, and the locked row
    // comes back as the statement's older snapshot saw it, audible. This fresh
    // statement sees the committed revocation, whose purge already ran.
    const [audible] = await tx
      .select({ id: tracks.id })
      .from(tracks)
      .where(and(eq(tracks.id, trackId), viewerCanReadTrack(viewerUserId)))
      .limit(1);
    if (!audible) return null;
  }
  return { id: track.id, ownerUserId: track.ownerUserId, status: track.status };
}

/**
 * A VISITOR's relationship to a foreign track, in the flag payload shape: the
 * shelves derive from the visitor's own memberships (any playlist = saved,
 * Favorites = favorited), because the track row's flags are the OWNER's Library
 * facts and must never be served — or written — cross-owner.
 */
async function readViewerReferenceFlagsInTx(
  tx: Transaction,
  viewerUserId: string,
  trackId: string,
): Promise<Exclude<TrackFlagWriteResult, 'removed' | null>> {
  const [row] = await tx
    .select({
      // Raw aggregates bypass the column decoders — map back to Date.
      savedAt: sql<Date | null>`min(${playlistTracks.createdAt})`.mapWith(playlistTracks.createdAt),
      favoritedAt:
        sql<Date | null>`min(${playlistTracks.createdAt}) filter (where ${playlists.kind} = 'favorites')`.mapWith(
          playlistTracks.createdAt,
        ),
    })
    .from(playlistTracks)
    .innerJoin(playlists, eq(playlists.id, playlistTracks.playlistId))
    .where(and(eq(playlistTracks.trackId, trackId), eq(playlists.ownerUserId, viewerUserId)));
  const savedAt = row?.savedAt ?? null;
  const favoritedAt = row?.favoritedAt ?? null;
  return {
    trackId,
    savedAt,
    favoritedAt,
    dislikedAt: null,
    retentionClass: deriveTrackRetentionClass({ savedAt, favoritedAt, dislikedAt: null }),
  };
}

/** Read a track's flags back as the `trackFlagsSchema` payload shape. */
async function readTrackFlagsInTx(
  tx: Transaction,
  trackId: string,
): Promise<Exclude<TrackFlagWriteResult, 'removed' | null>> {
  const [row] = await tx
    .select({
      savedAt: tracks.savedAt,
      favoritedAt: tracks.favoritedAt,
      dislikedAt: tracks.dislikedAt,
    })
    .from(tracks)
    .where(eq(tracks.id, trackId))
    .limit(1);
  return { trackId, ...row!, retentionClass: deriveTrackRetentionClass(row!) };
}

/**
 * The star toggle: favorite = membership in the caller's Favorites system
 * playlist (auto-ensured, appended at the end); unfavorite removes that
 * membership — and, when Favorites was the track's ONLY playlist, the track
 * leaves the Library (retention is membership). Accepts a foreign
 * Lounge-audible track: Favorites is a save target like any other
 * playlist, so the star files a Shared reference and answers with the
 * caller's own shelves, never the owner's flags. Idempotent; same
 * null/'removed' posture as every retention write, plus `'failed'` when a
 * failed Track would be newly favorited.
 */
export async function setTrackFavorited(
  db: Database,
  args: { ownerUserId: string; trackId: string; favorited: boolean; now?: Date },
): Promise<TrackFlagWriteResult | 'failed'> {
  const now = args.now ?? new Date();
  return withOwnerPlaylistLock(db, args.ownerUserId, async (tx) => {
    const track = await lockSaveableTrack(tx, args.ownerUserId, args.trackId);
    if (track === null || track === 'removed') return track;
    if (args.favorited && track.status === 'failed') return 'failed';
    const foreign = track.ownerUserId !== args.ownerUserId;

    const favorites = await ensureFavoritesPlaylist(tx, { ownerUserId: args.ownerUserId });
    const [member] = await tx
      .select({ id: playlistTracks.id })
      .from(playlistTracks)
      .where(
        and(eq(playlistTracks.playlistId, favorites.id), eq(playlistTracks.trackId, args.trackId)),
      )
      .limit(1);

    if (args.favorited && !member) {
      await tx.insert(playlistTracks).values({
        playlistId: favorites.id,
        trackId: args.trackId,
        position: await nextPlaylistPosition(tx, favorites.id),
      });
    } else if (!args.favorited && member) {
      await tx.delete(playlistTracks).where(eq(playlistTracks.id, member.id));
      await resequencePlaylistInTx(tx, favorites.id);
    }
    if (args.favorited === !member) {
      await tx.update(playlists).set({ updatedAt: now }).where(eq(playlists.id, favorites.id));
      await syncTrackFlagsInTx(tx, {
        ownerUserId: args.ownerUserId,
        trackIds: [args.trackId],
        now,
      });
    }
    return foreign
      ? readViewerReferenceFlagsInTx(tx, args.ownerUserId, args.trackId)
      : readTrackFlagsInTx(tx, args.trackId);
  });
}

/**
 * Unsave = remove the track from EVERY playlist (there is no standalone saved
 * state — retention is membership). The `/api/tracks/save` unsave path.
 */
export async function unsaveTrackEverywhere(
  db: Database,
  args: { ownerUserId: string; trackId: string; now?: Date },
): Promise<TrackFlagWriteResult> {
  const now = args.now ?? new Date();
  return withOwnerPlaylistLock(db, args.ownerUserId, async (tx) => {
    const track = await lockTrackForRetention(tx, args.ownerUserId, args.trackId);
    if (track === null || track === 'removed') return track;

    await purgeTrackMembershipsInTx(tx, args.trackId);
    await syncTrackFlagsInTx(tx, { ownerUserId: args.ownerUserId, trackIds: [args.trackId], now });
    return readTrackFlagsInTx(tx, args.trackId);
  });
}

export interface ApplyTrackMembershipsResult {
  /** The track's resulting membership (playlist ids), including any inline-created playlist. */
  playlistIds: string[];
  /** Set when `createPlaylistName` minted a new playlist in the same commit. */
  createdPlaylistId: string | null;
  /** The track's flags after the commit (the `trackFlagsSchema` payload). */
  flags: Exclude<TrackFlagWriteResult, 'removed' | null>;
  /** What an Add to Playlist control reports after the commit — something
   *  `flags.savedAt` cannot say, since Favorites sets that too. */
  inCuratedPlaylist: boolean;
}

/**
 * Atomically set ONE track's full desired playlist membership — the picker
 * sheet's commit. Missing desired playlists are added (appended at the end),
 * undesired ones removed, an optional inline `createPlaylistName` mints a new
 * user playlist that also receives the track, and the retention flags + audits
 * are derived once at the end — so save/unsave can never half-apply. Desired
 * ids that are absent/not owned are ignored (the IDOR posture). Returns
 * `'removed'` for a rejected/deleted track (no longer saveable), `'failed'` when
 * a failed Track would join a Playlist, null when the
 * track is absent/not owned — unless it is Lounge-audible: then the
 * commit files it as a Shared reference, an ordinary membership row in the
 * caller's own playlists that flips none of the owner's flags and appends no
 * audit (`syncTrackFlagsInTx` counts owner memberships only), and the returned
 * shelves are the caller's own relationship to the track.
 */
export async function applyTrackMemberships(
  db: Database,
  args: {
    ownerUserId: string;
    trackId: string;
    playlistIds: string[];
    createPlaylistName?: string;
    now?: Date;
  },
): Promise<ApplyTrackMembershipsResult | 'removed' | 'failed' | null> {
  const now = args.now ?? new Date();
  return withOwnerPlaylistLock(db, args.ownerUserId, async (tx) => {
    const track = await lockSaveableTrack(tx, args.ownerUserId, args.trackId);
    if (track === null || track === 'removed') return track;
    const foreign = track.ownerUserId !== args.ownerUserId;

    // Resolve the desired set to playlists the owner actually has, id-ordered
    // row locks (deadlock-safe against concurrent membership writes).
    const desiredIds = [...new Set(args.playlistIds)];
    const owned =
      desiredIds.length === 0
        ? []
        : await tx
            .select({
              id: playlists.id,
              kind: playlists.kind,
              listedInPlaylists: playlists.listedInPlaylists,
            })
            .from(playlists)
            .where(
              and(inArray(playlists.id, desiredIds), eq(playlists.ownerUserId, args.ownerUserId)),
            )
            .orderBy(asc(playlists.id))
            .for('update');
    const desired = new Set(owned.map((p) => p.id));
    const curated = new Set(owned.filter(isCuratedPlaylist).map((p) => p.id));

    const current = await tx
      .select({ playlistId: playlistTracks.playlistId, sharedAt: playlists.sharedAt })
      .from(playlistTracks)
      .innerJoin(playlists, eq(playlists.id, playlistTracks.playlistId))
      .where(
        and(eq(playlistTracks.trackId, args.trackId), eq(playlists.ownerUserId, args.ownerUserId)),
      );
    const currentIds = new Set(current.map((c) => c.playlistId));
    const sharedById = new Map(current.map((c) => [c.playlistId, c.sharedAt !== null]));
    // A failed Track may leave Playlists but never join one.
    if (
      track.status === 'failed' &&
      (args.createPlaylistName || [...desired].some((id) => !currentIds.has(id)))
    ) {
      return 'failed';
    }

    let createdPlaylistId: string | null = null;
    if (args.createPlaylistName) {
      const created = await createPlaylist(tx, {
        ownerUserId: args.ownerUserId,
        name: args.createPlaylistName,
      });
      createdPlaylistId = created.id;
      desired.add(created.id);
      // An inline playlist is owner-named and listed by construction.
      curated.add(created.id);
    }

    let leftSharingPlaylist = false;
    for (const playlistId of [...currentIds].filter((id) => !desired.has(id))) {
      await tx
        .delete(playlistTracks)
        .where(
          and(eq(playlistTracks.playlistId, playlistId), eq(playlistTracks.trackId, args.trackId)),
        );
      await resequencePlaylistInTx(tx, playlistId);
      await tx.update(playlists).set({ updatedAt: now }).where(eq(playlists.id, playlistId));
      if (sharedById.get(playlistId)) leftSharingPlaylist = true;
    }
    for (const playlistId of [...desired].filter((id) => !currentIds.has(id))) {
      await tx.insert(playlistTracks).values({
        playlistId,
        trackId: args.trackId,
        position: await nextPlaylistPosition(tx, playlistId),
      });
      await tx.update(playlists).set({ updatedAt: now }).where(eq(playlists.id, playlistId));
    }
    // Unfiling the OWNER's track from an In-Lounge playlist is a membership
    // removal at a sharing chokepoint: re-check audibility and purge. It runs
    // after the adds, so a move into another In-Lounge playlist in the same
    // commit never reads as a revocation.
    // A visitor rearranging their own references can never revoke anything.
    if (!foreign && leftSharingPlaylist) {
      await purgeRevokedSharedReferencesInTx(tx, { trackIds: [args.trackId] });
    }

    await syncTrackFlagsInTx(tx, { ownerUserId: args.ownerUserId, trackIds: [args.trackId], now });
    return {
      playlistIds: [...desired],
      createdPlaylistId,
      flags: foreign
        ? await readViewerReferenceFlagsInTx(tx, args.ownerUserId, args.trackId)
        : await readTrackFlagsInTx(tx, args.trackId),
      inCuratedPlaylist: curated.size > 0,
    };
  });
}

/**
 * Outcome of a playlist management write: applied, refused because the target
 * is the Favorites system playlist, or null (absent / not owned).
 */
export type PlaylistManageResult<T extends string> = T | 'system' | null;

/** Rename an owned user playlist. The Favorites system playlist refuses (`'system'`). */
export async function renamePlaylist(
  db: Database,
  args: { ownerUserId: string; playlistId: string; name: string; now?: Date },
): Promise<PlaylistManageResult<'renamed'>> {
  return withTransaction(db, async (tx) => {
    const playlist = await lockOwnedPlaylist(tx, args.ownerUserId, args.playlistId);
    if (!playlist) return null;
    if (playlist.kind === 'favorites') return 'system';
    await tx
      .update(playlists)
      .set({ name: args.name, updatedAt: args.now ?? new Date() })
      .where(eq(playlists.id, playlist.id));
    return 'renamed';
  });
}

/**
 * A live cover attempt outlives its Playlist's delete as a ledger row with no
 * subject, which no job can drive or settle — it would stay live, and the
 * aged-cover scan would retry it ahead of every other attempt. Settle it the
 * way recovery settles a lost attempt: an unclaimed one keeps whatever spend
 * it holds, a claimed submission counts as paid. The worker's state-guarded
 * transitions then no-op.
 */
async function settleLivePlaylistCoverAttempts(tx: Transaction, playlistId: string, now: Date) {
  const ofPlaylist = eq(sessionCoverGenerations.playlistId, playlistId);
  await tx
    .update(sessionCoverGenerations)
    .set({
      state: 'not_admitted',
      failureCategory: 'playlist_deleted',
      settledAt: now,
      updatedAt: now,
    })
    .where(and(ofPlaylist, inArray(sessionCoverGenerations.state, ['reserved', 'planned'])));
  await tx
    .update(sessionCoverGenerations)
    .set({
      state: 'submission_unknown',
      failureCategory: 'submission_unknown',
      possiblyPaid: true,
      settledAt: now,
      updatedAt: now,
    })
    .where(and(ofPlaylist, inArray(sessionCoverGenerations.state, ['submitting', 'storing'])));
}

/**
 * Delete an owned user playlist. Memberships go with it and every affected
 * track's retention flags are re-derived — members with no other playlist
 * leave the Library (unsave audit). The Favorites system playlist refuses.
 */
export async function deletePlaylist(
  db: Database,
  args: { ownerUserId: string; playlistId: string; now?: Date },
): Promise<PlaylistManageResult<'deleted'>> {
  const now = args.now ?? new Date();
  return withOwnerPlaylistLock(db, args.ownerUserId, async (tx) => {
    const playlist = await lockOwnedPlaylist(tx, args.ownerUserId, args.playlistId);
    if (!playlist) return null;
    if (playlist.kind === 'favorites') return 'system';

    const members = await tx
      .select({ trackId: playlistTracks.trackId })
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, playlist.id));
    const memberTrackIds = [...new Set(members.map((m) => m.trackId))].sort();
    await lockEligibleTracks(tx, args.ownerUserId, memberTrackIds);
    // Cover candidates key on the ledger's playlist edge, which the delete
    // clears — gathered before the delete, reclaimed after it, so the shared
    // unreferenced predicate needs no self-exclusion.
    const coverCandidateIds = await listSubjectCoverImageIds(
      tx,
      args.ownerUserId,
      playlistLedgerSubject(playlist.id),
    );
    await settleLivePlaylistCoverAttempts(tx, playlist.id, now);
    await tx.delete(playlists).where(eq(playlists.id, playlist.id));
    // Deleting an In-Lounge playlist is a revocation: references to
    // members that just stopped being Lounge-audible go in the same commit.
    if (playlist.sharedAt) {
      await purgeRevokedSharedReferencesInTx(tx, { trackIds: memberTrackIds });
    }
    const reclaimed = await deleteUnreferencedCoverRows(tx, { coverImageIds: coverCandidateIds });
    await queueCoverFileDeletions(tx, {
      ownerUserId: args.ownerUserId,
      covers: reclaimed,
      reason: 'playlist_deleted',
      now,
    });
    await syncTrackFlagsInTx(tx, { ownerUserId: args.ownerUserId, trackIds: memberTrackIds, now });
    return 'deleted';
  });
}

/**
 * Record that playlist playback engaged (the "played last" half of the
 * Playlists tab's activity order). Owner-scoped; false when absent/not owned.
 */
export async function touchPlaylistPlayed(
  db: Database,
  args: { ownerUserId: string; playlistId: string; now?: Date },
): Promise<boolean> {
  const updated = await db
    .update(playlists)
    .set({
      lastPlayedAt: args.now ?? new Date(),
      // Keep `updatedAt` meaning "last content/membership change": without this
      // the column's `$onUpdate` would bump it on every play.
      updatedAt: sql`${playlists.updatedAt}`,
    })
    .where(and(eq(playlists.id, args.playlistId), eq(playlists.ownerUserId, args.ownerUserId)))
    .returning({ id: playlists.id });
  return updated.length > 0;
}
