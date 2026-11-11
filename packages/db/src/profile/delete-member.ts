// Delete a Member without stranding their bytes.
//
// Every `owner_user_id` content FK is ON DELETE CASCADE, so deleting the user
// row wipes the Member's rows in one statement — BEFORE anything could learn
// their storage keys. The order here is the whole point: collect and enqueue
// every key first, then let the cascade run, then reclaim the covers the
// cascade just unreferenced. All of it is ONE transaction, so an interruption
// anywhere rolls back to a fully retryable state, and after commit the
// deletion queue drains on its own.
//
// The spend ledger is never deleted: `generation_requests` /
// `provider_jobs` and the cover ledger survive with a null owner (set-null
// FK) and keep counting in the Members Pool until their window rolls over —
// delete-and-recreate must not reset the Pool. The cover ledger's private plan
// is erased first, so only anonymous accounting outlives the Member.

import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { Database } from '../client';
import type { Transaction } from '../transactions';
import { deleteUnreferencedCoverRows, queueCoverFileDeletions } from '../covers/cover-reclaim';
import { acquireOwnerCoverArtLock } from '../covers/generated-repo';
import { acquireOwnerCoverAdmissionLock } from '../covers/generation-ledger-repo';
import {
  queueStorageObjectDeletion,
  queueOwnerTrackAudioDeletion,
} from '../generation/deletion-queue-repo';
import { withOwnerGenerationLock } from '../generation/limits-repo';
import { acquireOwnerPersonPhotoLock } from '../people/person-reference-photos-repo';
import {
  lockSelectedAudiencesNamingInTx,
  returnEmptySelectedAudiencesToPrivateInTx,
} from '../playlists/playlist-share-repo';
import {
  activitySessions,
  coverImages,
  emptySessionCoverPlan,
  personReferencePhotos,
  SESSION_COVER_LIVE_STATES,
  playlists,
  sessionCoverGenerations,
  tracks,
  user,
  userProfiles,
  voiceRecordings,
} from '../schema';

export const MEMBER_DELETE_REASON = 'member_deleted';

export type DeleteMemberResult =
  | { ok: true; trackCount: number; reclaimedCoverCount: number }
  | { ok: false; reason: 'not_member' };

/**
 * Cover rows the Member's content references or provenance names — gathered
 * BEFORE the cascade severs those edges. Reclamation itself stays behind the
 * one shared `deleteUnreferencedCoverRows` predicate, so a cover anything else
 * still references survives this list untouched.
 */
async function collectCoverCandidates(tx: Transaction, ownerUserId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: coverImages.id })
    .from(coverImages)
    .where(
      or(
        inArray(
          coverImages.id,
          tx
            .select({ id: tracks.coverImageId })
            .from(tracks)
            .where(and(eq(tracks.ownerUserId, ownerUserId), isNotNull(tracks.coverImageId))),
        ),
        inArray(
          coverImages.id,
          tx
            .select({ id: playlists.coverImageId })
            .from(playlists)
            .where(and(eq(playlists.ownerUserId, ownerUserId), isNotNull(playlists.coverImageId))),
        ),
        inArray(
          coverImages.id,
          tx
            .select({ id: activitySessions.coverImageId })
            .from(activitySessions)
            .where(
              and(
                eq(activitySessions.ownerUserId, ownerUserId),
                isNotNull(activitySessions.coverImageId),
              ),
            ),
        ),
        inArray(
          coverImages.id,
          tx
            .select({ id: sessionCoverGenerations.coverImageId })
            .from(sessionCoverGenerations)
            .where(eq(sessionCoverGenerations.ownerUserId, ownerUserId)),
        ),
        // Uploads carry no pointer until chosen; their provenance names the subject.
        sql`${coverImages.provenance} ->> 'activitySessionId' in (select ${activitySessions.id}::text from ${activitySessions} where ${activitySessions.ownerUserId} = ${ownerUserId})`,
        sql`${coverImages.provenance} ->> 'playlistId' in (select ${playlists.id}::text from ${playlists} where ${playlists.ownerUserId} = ${ownerUserId})`,
      ),
    );
  return rows.map((row) => row.id);
}

/**
 * Reduce the Member's cover ledger to anonymous accounting before the cascade
 * nulls its owner. A live attempt is settled here because nothing can finish it
 * once the owner is gone: one that may have reached the provider keeps counting
 * as possibly paid, one that never submitted moved no money. The subject edges
 * are severed by hand (the session edge is a composite FK with no ON DELETE
 * action) so the ledger stops holding the Member's covers, and every field
 * carrying their art direction, People or prompt is blanked.
 */
async function eraseCoverLedger(tx: Transaction, ownerUserId: string, now: Date): Promise<void> {
  const owned = eq(sessionCoverGenerations.ownerUserId, ownerUserId);
  const live = inArray(sessionCoverGenerations.state, [...SESSION_COVER_LIVE_STATES]);
  await tx
    .update(sessionCoverGenerations)
    .set({
      state: 'submission_unknown',
      submissionDisposition: 'outcome_unknown',
      failureCategory: MEMBER_DELETE_REASON,
      settledAt: now,
    })
    .where(and(owned, live, eq(sessionCoverGenerations.possiblyPaid, true)));
  await tx
    .update(sessionCoverGenerations)
    .set({ state: 'not_admitted', failureCategory: MEMBER_DELETE_REASON, settledAt: now })
    .where(and(owned, live));
  await tx
    .update(sessionCoverGenerations)
    .set({
      activitySessionId: null,
      playlistId: null,
      plan: emptySessionCoverPlan(),
      planHash: '',
      promptHash: '',
      fingerprint: {},
      selectedReferences: [],
      seed: null,
    })
    .where(owned);
}

export async function deleteMember(
  db: Database,
  input: {
    userId: string;
    /**
     * The avatar's storage key, derived by the caller from `user.image` (the
     * key has no column of its own). Null/omitted when the Member has none.
     */
    avatarStorageKey?: string | null;
    now?: Date;
  },
): Promise<DeleteMemberResult> {
  const now = input.now ?? new Date();
  // Same lock chain the money paths use (owner generation lock first, then the
  // cover locks) so an in-flight music or cover admission for this Member
  // commits or fails cleanly before the rows vanish under it. A music submit's
  // paid POST runs after its admission releases the lock, so one admitted just
  // before this delete can still reach the provider; its ledger rows survive
  // the cascade and keep counting.
  return withOwnerGenerationLock(db, input.userId, async (tx) => {
    await acquireOwnerCoverAdmissionLock(tx, input.userId);
    // Every photo write holds this lock, so the photo select below sees each
    // committed upload, and a later one finds no Person and queues its own bytes.
    // Photo before cover-art, the order deletePerson and photo delete use.
    await acquireOwnerPersonPhotoLock(tx, input.userId);
    await acquireOwnerCoverArtLock(tx, input.userId);

    const [profile] = await tx
      .select({ role: userProfiles.role })
      .from(userProfiles)
      .where(eq(userProfiles.userId, input.userId));
    if (profile?.role !== 'member') return { ok: false as const, reason: 'not_member' as const };

    // 1) Track audio: snapshot every asset key into the queue (and drop the
    //    asset rows), exactly as user-facing track delete does — in bulk, because
    //    the owner's generation and cover locks are held for the whole block.
    //    The Track rows are locked first, as track delete does: a final download
    //    claims its row only after streaming, so without the lock one landing
    //    between this snapshot and the cascade would leave its file unqueued.
    //    Locked, the claim waits, finds the Track gone and queues its own file.
    await tx
      .select({ id: tracks.id })
      .from(tracks)
      .where(eq(tracks.ownerUserId, input.userId))
      .orderBy(asc(tracks.id))
      .for('update');
    const trackCount = await queueOwnerTrackAudioDeletion(tx, {
      ownerUserId: input.userId,
      reason: MEMBER_DELETE_REASON,
      deleteAfter: now,
    });

    // 2) The direct-keyed files: person reference photos, voice recordings,
    //    and the avatar the caller resolved.
    const photoRows = await tx
      .select({ storageKey: personReferencePhotos.storageKey })
      .from(personReferencePhotos)
      .where(eq(personReferencePhotos.ownerUserId, input.userId));
    const voiceRows = await tx
      .select({ storageKey: voiceRecordings.storageKey })
      .from(voiceRecordings)
      .where(eq(voiceRecordings.ownerUserId, input.userId));
    const directKeys = [
      ...photoRows.map((row) => row.storageKey),
      ...voiceRows.map((row) => row.storageKey),
      ...(input.avatarStorageKey ? [input.avatarStorageKey] : []),
    ];
    for (const storageKey of directKeys) {
      await queueStorageObjectDeletion(tx, {
        ownerUserId: input.userId,
        storageKey,
        reason: MEMBER_DELETE_REASON,
        deleteAfter: now,
      });
    }

    // 3) Cover candidates, while the referencing rows still exist.
    const coverCandidates = await collectCoverCandidates(tx, input.userId);

    // 4) The cover ledger, down to anonymous accounting.
    await eraseCoverLedger(tx, input.userId, now);

    // 5) The cascade: content rows go, ledger owners go null, the queue rows
    //    written above go ownerless but stay. It also drops the Member from
    //    other owners' `selected` share audiences; one left with nobody
    //    returns to Private.
    await lockSelectedAudiencesNamingInTx(tx, input.userId);
    await tx.delete(user).where(eq(user.id, input.userId));
    await returnEmptySelectedAudiencesToPrivateInTx(tx);

    // 6) Reclaim what the cascade unreferenced — through the one shared
    //    predicate — and queue the files (original + rendition) ownerless.
    const reclaimed = await deleteUnreferencedCoverRows(tx, { coverImageIds: coverCandidates });
    await queueCoverFileDeletions(tx, {
      ownerUserId: null,
      covers: reclaimed,
      reason: MEMBER_DELETE_REASON,
      now,
    });

    return {
      ok: true as const,
      trackCount,
      reclaimedCoverCount: reclaimed.length,
    };
  });
}
