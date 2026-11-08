// Listener-feedback + library writes/reads. Track flags
// (`savedAt`/`favoritedAt`/`dislikedAt`) are the source of truth; `feedback_events`
// is the append-only audit trail — there is NO `ratings` table. Every function is
// OWNER-SCOPED (an UPDATE/SELECT guarded by `ownerUserId`), so a cross-owner trackId
// is indistinguishable from a missing one (the route returns 404 — the IDOR posture).
//
// The Dislike path (`rejectDislikedTrack`) deliberately reuses the EXISTING
// deletion-queue mechanism rather than hand-rolling deletion: it flips the track to
// the **Reject** retention class (`dislikedAt` set ⇒ `deriveTrackRetentionClass`),
// removes it from the queue so the worker buffer controller tops the session back up
// through its normal cost-gated path (that top-up IS the reroll's fresh-generation
// branch), and drops the audio assets / queues the ~24h file purge through the
// shared `queueTrackAudioDeletion` — the same write session deletion uses, only
// with a 24h `deleteAfter` instead of now. Dislike never steers.

import { and, desc, eq, exists, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  LIVE_QUEUE_ITEM_STATES,
  type FeedbackType,
  type TrackRetentionClass,
  type VocalMode,
} from '@liedmotif/shared';
import type { Database } from '../client';
import { servableLocalFinalConditions } from './audio-asset-predicates';
import { effectiveTrackCoverColumn } from '../covers/effective-track-cover';
import { withTransaction, type Transaction } from '../transactions';
import {
  activitySessionQueueItems,
  activitySessions,
  feedbackEvents,
  generationRequests,
  providerJobs,
  playbackEvents,
  tracks,
  trackAudioAssets,
} from '../schema';
import { curatedPlaylistMemberColumn } from '../playlists/curated-membership';
import { recordTasteEvidenceInTx } from '../analytics/taste-repo';
import { purgeTrackMembershipsInTx } from '../playlists/membership-purge';
import { searchBoxCondition, trackMatchFields } from '../search/match';
import { queueTrackAudioDeletion } from './deletion-queue-repo';
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor';
import { trackHasLyricsColumn } from './lyrics-repo';
import { sessionNotPendingDelete } from './session-list-repo';

/** Reason recorded on a queued Reject (disliked-track) file purge. */
export const REJECT_PURGE_REASON = 'reject_purge';

/** Grace before a Rejected track's audio + row are eligible for deletion (~24h). */
export const REJECT_GRACE_MS = 24 * 60 * 60 * 1000;

// --- flag writes (save / favorite) ----------------------------------------------

/** A track's resolved retention flags + derived class — the `trackFlagsSchema` payload. */
export interface TrackFlagsResult {
  trackId: string;
  savedAt: Date | null;
  favoritedAt: Date | null;
  dislikedAt: Date | null;
  retentionClass: TrackRetentionClass;
}

/**
 * A retention write's outcome: the updated flags, `'removed'` when the track is
 * `rejected`/`deleted` (leaving the library — no longer flaggable; routes map it
 * to a 409), or null when it is absent/not owned (the 404 IDOR posture). The
 * writers live in the playlists repo (retention is playlist membership).
 */
export type TrackFlagWriteResult = TrackFlagsResult | 'removed' | null;

// --- dislike (reroll/reject) ----------------------------------------------------

export interface RejectDislikedTrackResult {
  /** True when the track was ALREADY disliked (idempotent no-op — no new reject/audit). */
  alreadyDisliked: boolean;
  dislikedAt: Date;
}

/**
 * Reject a disliked track (hidden now, deleted after ~24h). Owner-scoped;
 * null when the track is absent or not owned. Idempotent: a second Dislike returns
 * `{ alreadyDisliked: true }` and changes nothing. On the first Dislike, in ONE
 * transaction it:
 *   1. flips the track to Reject (`dislikedAt`, `status='rejected'`);
 *   2. appends a `dislike` audit row;
 *   3. marks its queue item(s) `rejected` so the buffer controller sees the gap and
 *      tops the session up through its EXISTING cost-gated path (the reroll's
 *      fresh-generation branch — never a second spend path here);
 *   4. drops the audio assets (hidden immediately) and queues the file bytes for the
 *      ~24h purge via the shared `queueTrackAudioDeletion` (same write as
 *      session deletion, only with a 24h `deleteAfter`).
 * Dislike NEVER steers future generation.
 */
export async function rejectDislikedTrack(
  db: Database,
  args: {
    ownerUserId: string;
    trackId: string;
    activitySessionId?: string | null;
    now?: Date;
    graceMs?: number;
  },
): Promise<RejectDislikedTrackResult | null> {
  return withTransaction(db, (tx) => rejectDislikedTrackInTx(tx, args));
}

/**
 * `rejectDislikedTrack`'s transactional body, for callers that must compose the
 * reject into a LARGER transaction — the dislike route rejects, resolves the
 * reroll replacement, and records the fresh-call reroll intent in ONE commit, so
 * a buffer sweep can never see the queue gap without the intent (and a crashed
 * request never leaves a rejected track whose retry is a no-op that records no
 * intent). Same guards, same idempotency — only the transaction boundary moves.
 */
export async function rejectDislikedTrackInTx(
  tx: Transaction,
  args: {
    ownerUserId: string;
    trackId: string;
    activitySessionId?: string | null;
    now?: Date;
    graceMs?: number;
  },
): Promise<RejectDislikedTrackResult | null> {
  const now = args.now ?? new Date();
  const graceMs = args.graceMs ?? REJECT_GRACE_MS;
  // The ~24h grace lives on the queued file deletion.
  const purgeAt = new Date(now.getTime() + graceMs);

  // Serialize sibling Dislikes on their shared ProviderJob: without this lock,
  // two concurrent dislikes of siblings A and B each see the OTHER track's
  // pre-transaction `ready` row, both report a $0 sibling reroll, and neither
  // records the fresh-call intent — the session is then topped up from the LIVE
  // snapshot (wrong vibe after a Change Vibe). The second transaction now waits
  // here and re-reads the committed rejection.
  await tx.execute(sql`
    select pj.id from ${providerJobs} pj
    join ${tracks} t on t.provider_job_id = pj.id
    where t.id = ${args.trackId}
    for update of pj
  `);

  // A rejected track leaves every retention surface: flags cleared here, its
  // playlist memberships purged below (retention is membership — a Reject must
  // not linger as a checked box or a playlist row).
  const updated = await tx
    .update(tracks)
    .set({
      dislikedAt: now,
      status: 'rejected',
      savedAt: null,
      favoritedAt: null,
      // Cleared with the tombstone: a pointer-bearing rejected row would hold
      // its cover_images row alive forever in cover reclamation.
      coverImageId: null,
    })
    .where(
      and(
        eq(tracks.id, args.trackId),
        eq(tracks.ownerUserId, args.ownerUserId),
        isNull(tracks.dislikedAt),
        // Only a live Track may become `rejected` (`TRACK_STATUS_TRANSITIONS`).
        // A deleted or failed one already left its slot, so a reroll for it
        // would buy a replacement for a Track nobody lost.
        inArray(tracks.status, ['pending', 'streamable', 'ready']),
      ),
    )
    .returning({ id: tracks.id });

  if (updated.length === 0) {
    // No fresh reject: disambiguate already-disliked or no-longer-live
    // (idempotent no-op) from not-owned.
    const [existing] = await tx
      .select({ dislikedAt: tracks.dislikedAt })
      .from(tracks)
      .where(and(eq(tracks.id, args.trackId), eq(tracks.ownerUserId, args.ownerUserId)))
      .limit(1);
    if (!existing) return null;
    return { alreadyDisliked: true, dislikedAt: existing.dislikedAt ?? now };
  }

  await tx.insert(feedbackEvents).values({
    userId: args.ownerUserId,
    trackId: args.trackId,
    activitySessionId: args.activitySessionId ?? null,
    feedbackType: 'dislike',
  });

  // Remove it from the queue so the buffer controller's ready-ahead count drops and
  // its next sweep tops up through the EXISTING limit machinery (the reroll). Only
  // LIVE slots move — a terminal `played`/`skipped`/`failed` item keeps its state
  // (per `QUEUE_ITEM_TRANSITIONS`; the slot already stopped counting).
  await tx
    .update(activitySessionQueueItems)
    .set({ state: 'rejected' })
    .where(
      and(
        eq(activitySessionQueueItems.trackId, args.trackId),
        inArray(activitySessionQueueItems.state, [...LIVE_QUEUE_ITEM_STATES]),
      ),
    );

  await purgeTrackMembershipsInTx(tx, args.trackId);
  // Track-level evidence for learned taste only: it discounts this Track's own
  // plays and steers nothing.
  await recordTasteEvidenceInTx(tx, {
    ownerUserId: args.ownerUserId,
    trackId: args.trackId,
    kind: 'reroll',
    gained: true,
  });

  // Hide immediately + queue the ~24h file purge (the Reject retention path).
  await queueTrackAudioDeletion(tx, {
    trackId: args.trackId,
    ownerUserId: args.ownerUserId,
    reason: REJECT_PURGE_REASON,
    deleteAfter: purgeAt,
  });

  return { alreadyDisliked: false, dislikedAt: now };
}

// --- general audit write (sendFeedback; covers Skip) ----------------------------

/**
 * Append a `feedback_events` audit row (the general write behind `/api/feedback`,
 * e.g. the Skip soft-negative). AUDIT-ONLY: this NEVER mutates track flags or feeds
 * generation/steering — the dedicated save/favorite/dislike paths own the
 * flags. The route validates that `trackId`/`activitySessionId` belong to the actor
 * before calling, so this stays a thin insert.
 */
export async function recordFeedbackEvent(
  db: Database,
  args: {
    userId: string;
    trackId: string;
    activitySessionId?: string | null;
    feedbackType: FeedbackType;
    value?: string | null;
    freeformText?: string | null;
  },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(feedbackEvents)
    .values({
      userId: args.userId,
      trackId: args.trackId,
      activitySessionId: args.activitySessionId ?? null,
      feedbackType: args.feedbackType,
      feedbackValue: args.value ?? null,
      freeformText: args.freeformText ?? null,
    })
    .returning({ id: feedbackEvents.id });
  return { id: row!.id };
}

// --- library reads --------------------------------------------------------------

/** One owned Track row, with the fields the player `trackSummary` needs. */
export interface OwnedTrackSummary {
  id: string;
  title: string | null;
  generatedArtistName: string | null;
  status: 'pending' | 'streamable' | 'ready' | 'rejected' | 'deleted' | 'failed';
  durationSeconds: number | null;
  coverImageId: string | null;
  savedAt: Date | null;
  favoritedAt: Date | null;
  dislikedAt: Date | null;
  inCuratedPlaylist: boolean;
  genreTags: string[];
  vocalMode: VocalMode;
  /** True once the provider-written lyric text is captured (vocal tracks only). */
  hasLyrics: boolean;
  /** True when a playable audio asset exists (the route maps it to an app audio path). */
  hasPlayableAudio: boolean;
  /** True when the DOWNLOADED local final is servable — the download-route gate
   *  (stricter than `hasPlayableAudio`, which a stream-only asset also satisfies). */
  hasFinalAsset: boolean;
}

export interface LibraryTrack extends OwnedTrackSummary {
  createdAt: Date;
  hasPlayed: boolean;
  /** Null when the origin Session was deleted (the track outlived it). */
  originSessionId: string | null;
  originSessionTitle: string | null;
}

export type LibraryView = 'saved' | 'favorites' | 'history';

export interface GetLibraryTracksResult {
  items: LibraryTrack[];
  nextCursor: string | null;
}

/**
 * "Has a playable audio asset" is a correlated drizzle subquery because a raw SQL
 * projection can bind an unqualified Track id to the asset table's id instead.
 */
export function trackSummaryColumns(db: Database) {
  return {
    id: tracks.id,
    title: tracks.title,
    generatedArtistName: tracks.generatedArtistName,
    status: tracks.status,
    durationSeconds: tracks.durationSeconds,
    coverImageId: tracks.coverImageId,
    savedAt: tracks.savedAt,
    favoritedAt: tracks.favoritedAt,
    dislikedAt: tracks.dislikedAt,
    inCuratedPlaylist: curatedPlaylistMemberColumn(db),
    genreTags: tracks.genreTags,
    vocalMode: tracks.vocalMode,
    hasLyrics: trackHasLyricsColumn(),
    hasPlayableAudio: sql<boolean>`${exists(
      db
        .select({ x: sql`1` })
        .from(trackAudioAssets)
        .where(and(eq(trackAudioAssets.trackId, tracks.id), eq(trackAudioAssets.isPlayable, true))),
    )}`,
    hasFinalAsset: sql<boolean>`${exists(
      db
        .select({ x: sql`1` })
        .from(trackAudioAssets)
        .where(and(eq(trackAudioAssets.trackId, tracks.id), servableLocalFinalConditions())),
    )}`,
  } as const;
}

/**
 * The full Library row projection — shared with search so a track's row facts
 * cannot diverge between surfaces.
 */
export function libraryColumns(db: Database) {
  return {
    ...trackSummaryColumns(db),
    coverImageId: effectiveTrackCoverColumn(activitySessions.coverImageId, tracks.coverImageId),
    createdAt: tracks.createdAt,
    hasPlayed: sql<boolean>`${exists(
      db
        .select({ x: sql`1` })
        .from(playbackEvents)
        .where(and(eq(playbackEvents.trackId, tracks.id), eq(playbackEvents.eventType, 'started'))),
    )}`,
    // A pending-delete session reads as already deleted: the row previews.
    originSessionId: sql<
      string | null
    >`case when ${sessionNotPendingDelete()} then ${activitySessions.id} end`,
    originSessionTitle: sql<
      string | null
    >`case when ${sessionNotPendingDelete()} then ${activitySessions.title} end`,
  } as const;
}

/** The per-view sort key (the timestamp the page is ordered + keyset-paged by). */
function viewSortColumn(view: LibraryView) {
  switch (view) {
    case 'saved':
      return tracks.savedAt;
    case 'favorites':
      return tracks.favoritedAt;
    case 'history':
      return tracks.createdAt;
  }
}

/** Cursor timestamps carry JavaScript (millisecond) precision; the ordering must too. */
function viewSortKey(view: LibraryView) {
  return sql<Date | string>`date_trunc('milliseconds', ${viewSortColumn(view)})`;
}

/**
 * The view's membership predicate (Saved set / Favorites set / surviving History).
 * EVERY view excludes Rejected/Deleted tracks: a disliked track leaves the library
 * even if its flags were set before the flag-write guard existed — the smart lists
 * must never list an unplayable, purging row.
 */
function viewFilter(view: LibraryView): SQL {
  const surviving = sql`${tracks.status} not in ('rejected', 'deleted')`;
  switch (view) {
    case 'saved':
      return sql`${tracks.savedAt} is not null and ${surviving}`;
    case 'favorites':
      return sql`${tracks.favoritedAt} is not null and ${surviving}`;
    case 'history':
      return surviving;
  }
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * List the owner's track-centric library for one view (Saved / Favorites / History),
 * most-recent-first, with keyset cursor paging (mirrors `listResumableSessions`).
 * Strictly owner-scoped — only the caller's own tracks are returned. The view's sort
 * timestamp rides along as `sortTs` so the cursor reads it generically (Saved/Favorites
 * page on `savedAt`/`favoritedAt`; History pages on `createdAt`).
 */
export async function getLibraryTracks(
  db: Database,
  args: {
    ownerUserId: string;
    view: LibraryView;
    cursor?: string | null;
    limit: number;
    /** Case-insensitive substring over the shared track match surface (see `trackMatchFields`). */
    search?: string | null;
  },
): Promise<GetLibraryTracksResult> {
  const sortColumn = viewSortKey(args.view);
  const cursor = args.cursor ? decodeKeysetCursor(args.cursor) : null;
  const conditions: SQL[] = [eq(tracks.ownerUserId, args.ownerUserId), viewFilter(args.view)];
  if (cursor) {
    // Keyset on (sortColumn, id) DESC: strictly past the previous page's last row.
    conditions.push(
      sql`(${sortColumn}, ${tracks.id}) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)`,
    );
  }
  // The shared match vocabulary: the same words in the Library box and in
  // /search select the same tracks (order and paging stay the view's own).
  const search = searchBoxCondition(trackMatchFields(), args.search);
  if (search) conditions.push(search);

  const rows = await db
    .select({ ...libraryColumns(db), sortTs: sql<Date | string>`${sortColumn}` })
    .from(tracks)
    .leftJoin(generationRequests, eq(generationRequests.id, tracks.generationRequestId))
    .leftJoin(
      activitySessions,
      and(
        eq(activitySessions.id, generationRequests.activitySessionId),
        eq(activitySessions.ownerUserId, args.ownerUserId),
      ),
    )
    .where(and(...conditions))
    .orderBy(desc(sortColumn), desc(tracks.id))
    .limit(args.limit + 1);

  const hasMore = rows.length > args.limit;
  const page = hasMore ? rows.slice(0, args.limit) : rows;
  const items: LibraryTrack[] = page.map(({ sortTs: _sortTs, ...row }) => ({
    ...row,
    hasPlayableAudio: row.hasPlayableAudio ?? false,
    hasFinalAsset: row.hasFinalAsset ?? false,
  }));

  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last && last.sortTs != null
      ? encodeKeysetCursor({ t: toDate(last.sortTs).toISOString(), id: last.id })
      : null;
  return { items, nextCursor };
}

/** Load a single owned track's summary row (owner-scoped; null when absent/not owned). */
export async function getOwnedTrackSummary(
  db: Database,
  args: { ownerUserId: string; trackId: string },
): Promise<OwnedTrackSummary | null> {
  const [row] = await db
    .select(trackSummaryColumns(db))
    .from(tracks)
    .where(and(eq(tracks.id, args.trackId), eq(tracks.ownerUserId, args.ownerUserId)))
    .limit(1);
  if (!row) return null;
  return {
    ...row,
    hasPlayableAudio: row.hasPlayableAudio ?? false,
    hasFinalAsset: row.hasFinalAsset ?? false,
  };
}
