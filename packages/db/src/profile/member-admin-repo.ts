// Members administration reads/writes.
//
// The listing is aggregates ONLY — counts, bytes, dates, budgets. No title,
// prompt, cover, or session name may ever be selected here: this surface is how
// the Admin sees growth and spend without a window into anyone's music.

import { and, eq, inArray, max, notInArray, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { deleteLogins } from '../logins';
import { withTransaction, type DbOrTx } from '../transactions';
import {
  personReferencePhotos,
  session,
  trackAudioAssets,
  tracks,
  user,
  userProfiles,
  voiceRecordings,
} from '../schema';

export interface MemberAccountRow {
  userId: string;
  /** The display name — account identity, not listening content. */
  name: string;
  joinedAt: Date;
  disabledAt: Date | null;
  /** The freshest login-session activity; null when never signed in. */
  lastActiveAt: Date | null;
  /** Live (not deleted/rejected) tracks — what a delete would take with it. */
  trackCount: number;
  /**
   * Stored audio + person-photo + voice bytes. Informational and a floor:
   * cover images carry no byte column, so their files ride on top of this.
   */
  storageBytes: number;
}

/** Every Member account with its aggregate footprint, in join order. */
export async function listMemberAccounts(db: DbOrTx): Promise<MemberAccountRow[]> {
  const profiles = await db
    .select({
      userId: userProfiles.userId,
      name: user.name,
      joinedAt: userProfiles.createdAt,
      disabledAt: userProfiles.disabledAt,
    })
    .from(userProfiles)
    .innerJoin(user, eq(user.id, userProfiles.userId))
    .where(eq(userProfiles.role, 'member'))
    .orderBy(userProfiles.createdAt);
  if (profiles.length === 0) return [];

  const memberIds = profiles.map((profile) => profile.userId);
  const bytes = sql<number>`coalesce(sum(${trackAudioAssets.byteSize}), 0)::double precision`;
  const [lastActives, audio, photos, voice] = await Promise.all([
    db
      .select({ userId: session.userId, lastActiveAt: max(session.updatedAt) })
      .from(session)
      .where(inArray(session.userId, memberIds))
      .groupBy(session.userId),
    db
      .select({
        ownerUserId: tracks.ownerUserId,
        trackCount: sql<number>`count(distinct ${tracks.id})::int`,
        bytes,
      })
      .from(tracks)
      .leftJoin(trackAudioAssets, eq(trackAudioAssets.trackId, tracks.id))
      .where(
        and(
          inArray(tracks.ownerUserId, memberIds),
          notInArray(tracks.status, ['deleted', 'rejected']),
        ),
      )
      .groupBy(tracks.ownerUserId),
    db
      .select({
        ownerUserId: personReferencePhotos.ownerUserId,
        bytes: sql<number>`coalesce(sum(${personReferencePhotos.byteSize}), 0)::double precision`,
      })
      .from(personReferencePhotos)
      .where(inArray(personReferencePhotos.ownerUserId, memberIds))
      .groupBy(personReferencePhotos.ownerUserId),
    db
      .select({
        ownerUserId: voiceRecordings.ownerUserId,
        bytes: sql<number>`coalesce(sum(${voiceRecordings.byteSize}), 0)::double precision`,
      })
      .from(voiceRecordings)
      .where(inArray(voiceRecordings.ownerUserId, memberIds))
      .groupBy(voiceRecordings.ownerUserId),
  ]);

  const lastActiveByUser = new Map(lastActives.map((row) => [row.userId, row.lastActiveAt]));
  const audioByUser = new Map(audio.map((row) => [row.ownerUserId, row]));
  const photoBytesByUser = new Map(photos.map((row) => [row.ownerUserId, row.bytes]));
  const voiceBytesByUser = new Map(voice.map((row) => [row.ownerUserId, row.bytes]));

  return profiles.map((profile) => {
    const owned = audioByUser.get(profile.userId);
    return {
      ...profile,
      lastActiveAt: lastActiveByUser.get(profile.userId) ?? null,
      trackCount: owned?.trackCount ?? 0,
      storageBytes:
        (owned?.bytes ?? 0) +
        (photoBytesByUser.get(profile.userId) ?? 0) +
        (voiceBytesByUser.get(profile.userId) ?? 0),
    };
  });
}

/**
 * Disable (or re-enable) a Member — never the Admin, structurally: the update
 * is predicated on `role = 'member'`. Disabling also deletes the user's live
 * Logins, killing the Better Auth cookie-cache window; the per-request
 * profile read in the guards makes the block immediate either way, and
 * `createAuth`'s `session.create.before` hook is what stops the Member minting
 * a replacement Login. Everything the Member owns is kept, so re-enabling
 * restores access with nothing lost.
 */
export async function setMemberDisabled(
  db: Database,
  input: { userId: string; disabled: boolean; now?: Date },
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    const updated = await tx
      .update(userProfiles)
      .set({ disabledAt: input.disabled ? (input.now ?? new Date()) : null })
      .where(and(eq(userProfiles.userId, input.userId), eq(userProfiles.role, 'member')))
      .returning({ userId: userProfiles.userId });
    if (updated.length === 0) return false;
    if (input.disabled) {
      await deleteLogins(tx, input.userId);
    }
    return true;
  });
}
