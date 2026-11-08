// Cover-art reclamation — the ONE definition of "nothing references this
// cover". A cover survives while ANY of these hold it: a track / playlist /
// session `cover_image_id` pointer, a cover-ledger row whose subject edge is
// alive (the subject's selectable history), or an upload provenance naming a
// subject that still exists; the built-in placeholder is exempt by source
// type. Every deleter — session delete, playlist delete, the recurring
// orphan sweep — funnels through `deleteUnreferencedCoverRows`, so the
// deciding predicate cannot drift between them. Subject deleters gather their
// candidate ids FIRST, sever/delete the subject row, then reclaim: with the
// subject gone the shared predicate needs no self-exclusion.
//
// Ledger rows are never touched here — like `provider_jobs`, they are the
// cover-spend accounting and survive their subject.

import {
  and,
  eq,
  inArray,
  isNull,
  lt,
  ne,
  notExists,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm';
import { COVER_THUMBNAIL_EDGE } from '@liedmotif/shared';
import type { Database } from '../client';
import type { DbOrTx, Transaction } from '../transactions';
import {
  activitySessions,
  coverImages,
  generationRequests,
  playlists,
  sessionCoverGenerations,
  tracks,
} from '../schema';
import { queueStorageObjectDeletion } from '../generation/deletion-queue-repo';
import {
  listUploadedCoversForSubject,
  subjectWhere,
  type CoverLedgerSubject,
} from './generation-ledger-repo';
import { PLACEHOLDER_COVER_ID } from './placeholder';

/** Storage key of a cover's cached tile rendition (written by the covers route). */
export function coverRenditionKey(coverImageId: string): string {
  return `covers/renditions/${coverImageId}-w${COVER_THUMBNAIL_EDGE}.webp`;
}

export interface ReclaimedCover {
  coverImageId: string;
  storageKey: string;
}

/** Safety margin the sweep applies: never touch a cover this young (mid-attach). */
export const ORPHAN_COVER_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** Per-run cap for the sweep; the next run drains on. */
export const ORPHAN_COVER_SWEEP_LIMIT = 200;

function coverUnreferencedConditions(db: DbOrTx): SQL[] {
  return [
    ne(coverImages.sourceType, 'placeholder'),
    notExists(
      db
        .select({ one: sql`1` })
        .from(tracks)
        .where(eq(tracks.coverImageId, coverImages.id)),
    ),
    notExists(
      db
        .select({ one: sql`1` })
        .from(playlists)
        .where(eq(playlists.coverImageId, coverImages.id)),
    ),
    notExists(
      db
        .select({ one: sql`1` })
        .from(activitySessions)
        .where(eq(activitySessions.coverImageId, coverImages.id)),
    ),
    notExists(
      db
        .select({ one: sql`1` })
        .from(sessionCoverGenerations)
        .where(
          and(
            eq(sessionCoverGenerations.coverImageId, coverImages.id),
            sql`(${sessionCoverGenerations.activitySessionId} is not null
              or ${sessionCoverGenerations.playlistId} is not null)`,
          ),
        ),
    ),
    notExists(
      db
        .select({ one: sql`1` })
        .from(activitySessions)
        .where(
          sql`${activitySessions.id}::text = ${coverImages.provenance} ->> 'activitySessionId'`,
        ),
    ),
    notExists(
      db
        .select({ one: sql`1` })
        .from(playlists)
        .where(sql`${playlists.id}::text = ${coverImages.provenance} ->> 'playlistId'`),
    ),
  ];
}

/**
 * Delete the given cover rows — but only those the shared predicate confirms
 * unreferenced at delete time, so a cover attached since the caller's gather
 * is refused rather than clobbered. `olderThan` adds the sweep's age gate;
 * subject deleters omit it (their candidates are in-transaction consistent).
 * Returns what was actually removed; the caller owns byte disposal.
 */
export async function deleteUnreferencedCoverRows(
  db: DbOrTx,
  args: { coverImageIds: string[]; olderThan?: Date },
): Promise<ReclaimedCover[]> {
  if (args.coverImageIds.length === 0) return [];
  return db
    .delete(coverImages)
    .where(
      and(
        inArray(coverImages.id, args.coverImageIds),
        ...coverUnreferencedConditions(db),
        ...(args.olderThan ? [lt(coverImages.createdAt, args.olderThan)] : []),
      ),
    )
    .returning({ coverImageId: coverImages.id, storageKey: coverImages.storageKey });
}

/** The sweep's age gate: covers created after this instant are off limits. */
function orphanAgeCutoff(args: { now?: Date; minAgeMs?: number }): Date {
  const now = args.now ?? new Date();
  return new Date(now.getTime() - (args.minAgeMs ?? ORPHAN_COVER_MIN_AGE_MS));
}

/**
 * Unreferenced, sufficiently old cover rows — the sweep's byte-reclamation
 * candidates (see the module header for what counts as a reference).
 */
export async function listOrphanedCoverImages(
  db: Database,
  args: { now?: Date; limit?: number; minAgeMs?: number } = {},
): Promise<ReclaimedCover[]> {
  return db
    .select({ coverImageId: coverImages.id, storageKey: coverImages.storageKey })
    .from(coverImages)
    .where(
      and(...coverUnreferencedConditions(db), lt(coverImages.createdAt, orphanAgeCutoff(args))),
    )
    .limit(args.limit ?? ORPHAN_COVER_SWEEP_LIMIT);
}

/** Sweep row-drop for covers whose bytes the worker has reclaimed. Answers with
 *  the rows actually dropped, since the caller still owes their derived bytes. */
export async function deleteOrphanedCoverImageRows(
  db: Database,
  args: { coverImageIds: string[]; now?: Date; minAgeMs?: number },
): Promise<ReclaimedCover[]> {
  return deleteUnreferencedCoverRows(db, {
    coverImageIds: args.coverImageIds,
    olderThan: orphanAgeCutoff(args),
  });
}

/**
 * Every cover in a subject's history — generated attempts (via the ledger) and
 * uploads (via provenance). Gathered BEFORE the subject row is severed or
 * deleted, because both lookups key on the subject edge.
 */
export async function listSubjectCoverImageIds(
  db: DbOrTx,
  ownerUserId: string,
  subject: CoverLedgerSubject,
): Promise<string[]> {
  const generated = await db
    .select({ coverImageId: coverImages.id })
    .from(coverImages)
    .innerJoin(sessionCoverGenerations, eq(sessionCoverGenerations.coverImageId, coverImages.id))
    .where(and(eq(sessionCoverGenerations.ownerUserId, ownerUserId), subjectWhere(subject)));
  const uploaded = await listUploadedCoversForSubject(db, ownerUserId, subject);
  return [...new Set([...generated, ...uploaded].map((cover) => cover.coverImageId))];
}

/** Queue reclaimed covers' bytes (original + cached rendition) for deletion. */
export async function queueCoverFileDeletions(
  tx: Transaction,
  args: { ownerUserId: string | null; covers: ReclaimedCover[]; reason: string; now: Date },
): Promise<void> {
  for (const cover of args.covers) {
    for (const storageKey of [cover.storageKey, coverRenditionKey(cover.coverImageId)]) {
      await queueStorageObjectDeletion(tx, {
        ownerUserId: args.ownerUserId,
        storageKey,
        reason: args.reason,
        deleteAfter: args.now,
      });
    }
  }
}

/**
 * Surviving tracks take over a dying session's cover: covers resolve as
 * coalesce(session cover, track cover), so once the session row is gone the
 * track column is the only pointer left — without this write a Saved track
 * renders coverless while the cover bytes still exist. The placeholder is
 * exempt (it is the generic fallback a null pointer already renders as), and
 * a pointer a track already carries is never overwritten.
 */
export async function snapshotSessionCoverOntoTracks(
  tx: Transaction,
  args: { ownerUserId: string; sessionId: string; coverImageId: string | null },
): Promise<void> {
  if (!args.coverImageId || args.coverImageId === PLACEHOLDER_COVER_ID) return;
  await tx
    .update(tracks)
    .set({ coverImageId: args.coverImageId })
    .where(
      and(
        eq(tracks.ownerUserId, args.ownerUserId),
        isNull(tracks.coverImageId),
        notInArray(tracks.status, ['deleted', 'rejected']),
        inArray(
          tracks.generationRequestId,
          tx
            .select({ id: generationRequests.id })
            .from(generationRequests)
            .where(eq(generationRequests.activitySessionId, args.sessionId)),
        ),
      ),
    );
}
