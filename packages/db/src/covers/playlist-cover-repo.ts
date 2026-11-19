// Playlist custom-cover persistence: Playlist covers reuse the full Session-cover
// machinery. Attempts ride the SAME `session_cover_generations`
// ledger — keyed on `playlist_id` instead of `activity_session_id` — so the
// per-owner admission lock, the single-live-attempt guarantee, and the shared
// cover spend budget apply unchanged. Reads/writes are owner-scoped: a
// cross-owner id is indistinguishable from a missing one (the 404 IDOR posture).

import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../client';
import {
  coverImages,
  emptySessionCoverPlan,
  playlists,
  playlistTracks,
  tracks,
  type CoverMetadata,
} from '../schema';
import type { DbOrTx } from '../transactions';
import {
  deleteCoverFromHistoryForSubject,
  findCoverInSubjectHistory,
  getCoverHistoryEntryForSubject,
  getLatestCoverRegenerationForSubject,
  getLiveCoverGenerationForSubject,
  listCoverHistoryForSubject,
  listUploadedCoversForSubject,
  planCoverGenerationForSubject,
  playlistLedgerSubject,
  reservedCoverAttemptFields,
  withOwnerCoverAdmissionLock,
  type SessionCoverGenerationRow,
  type UploadedCover,
} from './generation-ledger-repo';

/** How many dominant member genre tags feed a Playlist cover plan. */
const PLAYLIST_COVER_GENRE_LIMIT = 3;

export interface PlaylistCoverSubject {
  id: string;
  name: string;
  kind: 'user' | 'favorites';
  coverImageId: string | null;
  /** Dominant member genre tags (by frequency, ties broken alphabetically). */
  genreTags: string[];
}

/**
 * The owned playlist plus the deterministic member-derived context a cover
 * plan is built from — a Playlist has no Style Snapshot, so its dominant
 * member genre tags stand in. Null when absent or not owned.
 */
export async function getPlaylistCoverSubject(
  db: DbOrTx,
  args: { ownerUserId: string; playlistId: string },
): Promise<PlaylistCoverSubject | null> {
  const [playlist] = await db
    .select({
      id: playlists.id,
      name: playlists.name,
      kind: playlists.kind,
      coverImageId: playlists.coverImageId,
    })
    .from(playlists)
    .where(and(eq(playlists.id, args.playlistId), eq(playlists.ownerUserId, args.ownerUserId)))
    .limit(1);
  if (!playlist) return null;
  const result = (await db.execute(sql`
    select tag.value as tag, count(*)::int as uses
    from ${playlistTracks} pt
    join ${tracks} t on t.id = pt.track_id
    cross join lateral jsonb_array_elements_text(t.genre_tags) as tag(value)
    where pt.playlist_id = ${playlist.id}
    group by tag.value
    order by uses desc, tag.value asc
    limit ${PLAYLIST_COVER_GENRE_LIMIT}
  `)) as { rows?: Array<{ tag?: unknown }> };
  const genreTags = (result.rows ?? [])
    .map((row) => row.tag)
    .filter((tag): tag is string => typeof tag === 'string' && tag.length > 0);
  return { ...playlist, genreTags };
}

/** The playlist's single live (non-terminal) attempt, if any. */
export async function getLivePlaylistCoverGeneration(
  db: DbOrTx,
  args: { ownerUserId: string; playlistId: string },
): Promise<SessionCoverGenerationRow | null> {
  return getLiveCoverGenerationForSubject(
    db,
    args.ownerUserId,
    playlistLedgerSubject(args.playlistId),
  );
}

/** The newest playlist regeneration attempt (live or settled), if any. */
export async function getLatestPlaylistCoverRegeneration(
  db: DbOrTx,
  args: { ownerUserId: string; playlistId: string },
): Promise<SessionCoverGenerationRow | null> {
  return getLatestCoverRegenerationForSubject(
    db,
    args.ownerUserId,
    playlistLedgerSubject(args.playlistId),
  );
}

/**
 * The playlist's settled generated covers (its selectable history), newest
 * first. Only attempts whose `cover_images` row still exists are listed —
 * every entry is servable and free to re-select.
 */
export async function listPlaylistCoverHistory(
  db: DbOrTx,
  args: { ownerUserId: string; playlistId: string; limit?: number },
): Promise<SessionCoverGenerationRow[]> {
  return listCoverHistoryForSubject(
    db,
    args.ownerUserId,
    playlistLedgerSubject(args.playlistId),
    args.limit,
  );
}

/**
 * Every cover the playlist keeps against its history cap: settled generated
 * covers, uploads, and the one attempt still in flight (it will land as a
 * cover, so its slot is already taken).
 *
 * The live attempt is read first: the worker settles an attempt `ready`
 * without the admission lock, so a settle landing between the reads may count
 * it twice for a moment, never not at all, and the cap can only err toward
 * refusing.
 */
export async function countPlaylistCoverHistory(
  db: DbOrTx,
  args: { ownerUserId: string; playlistId: string },
): Promise<number> {
  const live = await getLivePlaylistCoverGeneration(db, args);
  const generated = await listPlaylistCoverHistory(db, args);
  const uploaded = await listUploadedPlaylistCovers(db, args);
  return generated.length + uploaded.length + (live ? 1 : 0);
}

/** The history entry for one cover, or null when it is not in this playlist's history. */
export async function getPlaylistCoverHistoryEntry(
  db: DbOrTx,
  args: { ownerUserId: string; playlistId: string; coverImageId: string },
): Promise<SessionCoverGenerationRow | null> {
  return getCoverHistoryEntryForSubject(
    db,
    args.ownerUserId,
    playlistLedgerSubject(args.playlistId),
    args.coverImageId,
  );
}

/** Uploaded covers belonging to one playlist, newest first. */
export async function listUploadedPlaylistCovers(
  db: DbOrTx,
  args: { ownerUserId: string; playlistId: string },
): Promise<UploadedCover[]> {
  return listUploadedCoversForSubject(db, args.ownerUserId, playlistLedgerSubject(args.playlistId));
}

/** One cover from a playlist's history, generated or uploaded. */
export async function findCoverInPlaylistHistory(
  db: DbOrTx,
  args: { ownerUserId: string; playlistId: string; coverImageId: string },
): Promise<{ coverImageId: string; storageKey: string } | null> {
  return findCoverInSubjectHistory(
    db,
    args.ownerUserId,
    playlistLedgerSubject(args.playlistId),
    args.coverImageId,
  );
}

export type DeletePlaylistCoverResult = 'deleted' | 'not_found' | 'current_cover';

/**
 * Delete one cover from a playlist's history — a settled generated attempt or
 * an uploaded cover. The `cover_images` row goes and its bytes are queued for
 * reclamation; a generated attempt's ledger row stays untouched (spend
 * accounting and provenance survive — the history join simply stops listing
 * it). The playlist's CURRENT cover is never deletable (the pointer must stay
 * servable).
 */
export async function deletePlaylistCoverFromHistory(
  db: Database,
  args: { ownerUserId: string; playlistId: string; coverImageId: string; now?: Date },
): Promise<DeletePlaylistCoverResult> {
  return deleteCoverFromHistoryForSubject(db, args, {
    storageKey: async (tx) => (await findCoverInPlaylistHistory(tx, args))?.storageKey ?? null,
    currentCoverImageId: async (tx) => {
      const [playlist] = await tx
        .select({ coverImageId: playlists.coverImageId })
        .from(playlists)
        .where(and(eq(playlists.id, args.playlistId), eq(playlists.ownerUserId, args.ownerUserId)))
        .limit(1);
      return playlist?.coverImageId;
    },
    deletionReason: 'playlist_cover_history_deleted',
  });
}

/**
 * Point a playlist at a cover (or clear back to the derived mosaic with null),
 * owner-scoped. A pure pointer swap — the caller verifies the cover belongs to
 * this playlist. Returns false when the playlist is absent or not owned.
 */
export async function setPlaylistCoverImage(
  db: DbOrTx,
  args: { ownerUserId: string; playlistId: string; coverImageId: string | null },
): Promise<boolean> {
  const updated = await db
    .update(playlists)
    .set({ coverImageId: args.coverImageId, updatedAt: new Date() })
    .where(and(eq(playlists.id, args.playlistId), eq(playlists.ownerUserId, args.ownerUserId)))
    .returning({ id: playlists.id });
  return updated.length > 0;
}

export interface AddUploadedPlaylistCoverInput {
  ownerUserId: string;
  playlistId: string;
  /** The freshly stored upload's identity + location (bytes already written). */
  coverImageId: string;
  storageProvider: string;
  storageKey: string;
  /** Size of the written object — what the storage quota counts this cover as. */
  byteSize: number;
  /** Covers the playlist may keep, uploads and generated covers alike. */
  maxHistory: number;
}

export type AddUploadedPlaylistCoverResult = 'added' | 'not_found' | 'history_full';

/**
 * Register an uploaded cover in the playlist's history. It is an ordinary
 * history entry, previewed and applied like a generated one (the swap goes
 * through `setPlaylistCoverImage`), so the playlist keeps its current cover.
 * The cap is checked before anything changes, under the per-owner lock the
 * generation admission takes, so an upload and a generation cannot both take
 * the last slot. On `not_found` or `history_full` the caller compensates by
 * deleting the just-written bytes.
 */
export async function addUploadedPlaylistCover(
  db: Database,
  args: AddUploadedPlaylistCoverInput,
): Promise<AddUploadedPlaylistCoverResult> {
  return withOwnerCoverAdmissionLock(db, args.ownerUserId, async (tx) => {
    const [playlist] = await tx
      .select({ id: playlists.id })
      .from(playlists)
      .where(and(eq(playlists.id, args.playlistId), eq(playlists.ownerUserId, args.ownerUserId)))
      .limit(1);
    if (!playlist) return 'not_found';
    const kept = await countPlaylistCoverHistory(tx, args);
    if (kept >= args.maxHistory) return 'history_full';

    await tx.insert(coverImages).values({
      id: args.coverImageId,
      sourceType: 'uploaded',
      storageProvider: args.storageProvider,
      storageKey: args.storageKey,
      byteSize: args.byteSize,
      tags: { label: 'Uploaded playlist cover' },
      provenance: { ownerUserId: args.ownerUserId, playlistId: args.playlistId },
    });
    return 'added';
  });
}

export interface ReservePlaylistCoverRegenerationInput {
  id: string;
  ownerUserId: string;
  playlistId: string;
  coverImageId: string;
  storageKey: string;
  /** The attempt's style lane, resolved at request time (a Playlist persists no style). */
  coverStyle: string;
  /** The Custom lane's definition, frozen with the pick (null for preset lanes). */
  customDefinition?: string | null;
  /** Raw user art direction, frozen privately into the attempt (never logged). */
  userGuidance?: string;
  /** LLM-enhanced art direction that replaces the raw text when enhancement ran. */
  effectiveGuidance?: string;
  enhancementApplied?: boolean;
  /** The owner asked this attempt to carry their People reference photos. */
  usePeopleReferences?: boolean;
}

/**
 * Reserve a user-triggered playlist regeneration attempt. The plan is a
 * placeholder — the worker freezes the real plan when it picks the attempt up
 * — but the user's style pick and guidance are frozen here, at request time.
 * Returns null when the playlist already has a live attempt.
 */
export async function reservePlaylistCoverRegeneration(
  db: DbOrTx,
  input: ReservePlaylistCoverRegenerationInput,
): Promise<SessionCoverGenerationRow | null> {
  return planCoverGenerationForSubject(db, playlistLedgerSubject(input.playlistId), {
    id: input.id,
    ownerUserId: input.ownerUserId,
    ...reservedCoverAttemptFields(
      emptySessionCoverPlan({
        selectedStyle: input.coverStyle,
        resolvedStyle: input.coverStyle,
        customDefinition: input.customDefinition ?? null,
        ...(input.userGuidance === undefined ? {} : { userGuidance: input.userGuidance }),
        ...(input.effectiveGuidance === undefined
          ? {}
          : { effectiveGuidance: input.effectiveGuidance }),
        ...(input.enhancementApplied === undefined
          ? {}
          : { enhancementApplied: input.enhancementApplied }),
        ...(input.usePeopleReferences === undefined
          ? {}
          : { usePeopleReferences: input.usePeopleReferences }),
      }),
    ),
    idempotencyKey: `playlist-cover:regen:${input.id}`,
    coverImageId: input.coverImageId,
    storageKey: input.storageKey,
  });
}

export interface InsertGeneratedPlaylistCoverInput {
  /** Pre-generated id, so the storage key and row id agree. */
  id: string;
  ownerUserId: string;
  playlistId: string;
  storageProvider: string;
  storageKey: string;
  /** Size of the written object — what the storage quota counts this cover as. */
  byteSize: number;
  /** Short alt/label text (cosmetic; shown as the cover title). */
  label: string;
  model: string;
  visualTheme?: string | null;
  /** Extra safe provenance (promptVersion, hashes, costUsd, …). */
  provenance?: CoverMetadata;
}

/**
 * Insert a generated playlist `cover_images` row; returns its id. Idempotent
 * on the pre-generated id: a retry that finds its own row returns it, while a
 * conflicting identity fails loudly.
 */
export async function insertGeneratedPlaylistCoverImage(
  db: DbOrTx,
  input: InsertGeneratedPlaylistCoverInput,
): Promise<string> {
  const [row] = await db
    .insert(coverImages)
    .values({
      id: input.id,
      sourceType: 'generated',
      storageProvider: input.storageProvider,
      storageKey: input.storageKey,
      byteSize: input.byteSize,
      tags: { label: input.label, model: input.model },
      visualTheme: input.visualTheme ?? null,
      provenance: {
        ownerUserId: input.ownerUserId,
        playlistId: input.playlistId,
        model: input.model,
        ...input.provenance,
      },
    })
    .onConflictDoNothing({ target: coverImages.id })
    .returning({ id: coverImages.id });
  if (row) return row.id;
  const [existing] = await db
    .select()
    .from(coverImages)
    .where(eq(coverImages.id, input.id))
    .limit(1);
  const provenance = existing?.provenance as Record<string, unknown> | null;
  if (
    existing?.sourceType === 'generated' &&
    existing.storageKey === input.storageKey &&
    provenance?.ownerUserId === input.ownerUserId &&
    provenance?.playlistId === input.playlistId
  ) {
    return existing.id;
  }
  throw new Error('Generated playlist cover identity conflict.');
}
