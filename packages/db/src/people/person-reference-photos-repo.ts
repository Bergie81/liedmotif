import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { acquireOwnerCoverArtLock } from '../covers/generated-repo';
import { deletionQueueItems, people, personReferencePhotos } from '../schema';
import { withTransaction, type DbOrTx, type Transaction } from '../transactions';
import { OWNER_PERSON_PHOTO_LOCK_CLASS } from '../advisory-locks';
import { getCoverReferenceFrequency } from './people-settings-repo';

export const MAX_PERSON_REFERENCE_PHOTOS = 3;
export const MAX_OWNER_PERSON_REFERENCE_PHOTOS = 18;
export const PERSON_REFERENCE_PHOTO_DELETED_REASON = 'person_reference_photo_deleted';

export type PersonReferencePhotoRow = typeof personReferencePhotos.$inferSelect;

export interface InsertPersonReferencePhotoInput {
  id: string;
  ownerUserId: string;
  personId: string;
  storageProvider: string;
  storageKey: string;
  mediaType: string;
  originalFilename?: string | null;
  byteSize: number;
  width?: number | null;
  height?: number | null;
}

export type InsertPersonReferencePhotoResult =
  | { inserted: true; photo: PersonReferencePhotoRow }
  | {
      inserted: false;
      reason: 'person_not_found' | 'person_limit_reached' | 'owner_limit_reached';
    };

export async function acquireOwnerPersonPhotoLock(
  tx: Transaction,
  ownerUserId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${OWNER_PERSON_PHOTO_LOCK_CLASS}, hashtext(${ownerUserId}))`,
  );
}

export async function listPersonReferencePhotos(
  db: DbOrTx,
  input: { ownerUserId: string; personId?: string },
): Promise<PersonReferencePhotoRow[]> {
  return db
    .select()
    .from(personReferencePhotos)
    .where(
      input.personId
        ? and(
            eq(personReferencePhotos.ownerUserId, input.ownerUserId),
            eq(personReferencePhotos.personId, input.personId),
          )
        : eq(personReferencePhotos.ownerUserId, input.ownerUserId),
    )
    .orderBy(
      asc(personReferencePhotos.personId),
      asc(personReferencePhotos.createdAt),
      asc(personReferencePhotos.id),
    );
}

/**
 * Whether asking for Person reference photos on a cover could produce anything
 * for this owner: someone has a photo on file, and the hard opt-out is off.
 * Advisory — the cover machinery still re-checks both at plan and submission
 * time, when it is the frequency and the rows that count. `never` answers
 * before any photo row is read, so the opt-out covers the reads too.
 */
export async function coverReferencesAvailable(db: DbOrTx, ownerUserId: string): Promise<boolean> {
  if ((await getCoverReferenceFrequency(db, ownerUserId)) === 'never') return false;
  const [photo] = await db
    .select({ id: personReferencePhotos.id })
    .from(personReferencePhotos)
    .where(eq(personReferencePhotos.ownerUserId, ownerUserId))
    .limit(1);
  return photo !== undefined;
}

export async function getPersonReferencePhoto(
  db: DbOrTx,
  input: { ownerUserId: string; photoId: string },
): Promise<PersonReferencePhotoRow | null> {
  const [photo] = await db
    .select()
    .from(personReferencePhotos)
    .where(
      and(
        eq(personReferencePhotos.ownerUserId, input.ownerUserId),
        eq(personReferencePhotos.id, input.photoId),
      ),
    )
    .limit(1);
  return photo ?? null;
}

async function queueRejectedPhoto(
  tx: Transaction,
  input: InsertPersonReferencePhotoInput,
): Promise<void> {
  await tx.insert(deletionQueueItems).values({
    ownerUserId: input.ownerUserId,
    trackId: null,
    storageKey: input.storageKey,
    reason: PERSON_REFERENCE_PHOTO_DELETED_REASON,
    deleteAfter: new Date(),
  });
}

export async function insertPersonReferencePhoto(
  db: Database,
  input: InsertPersonReferencePhotoInput,
): Promise<InsertPersonReferencePhotoResult> {
  return withTransaction(db, async (tx) => {
    await acquireOwnerPersonPhotoLock(tx, input.ownerUserId);
    const [person] = await tx
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.ownerUserId, input.ownerUserId), eq(people.id, input.personId)))
      .limit(1);
    if (!person) {
      await queueRejectedPhoto(tx, input);
      return { inserted: false, reason: 'person_not_found' };
    }

    const ownerPhotos = await tx
      .select({ personId: personReferencePhotos.personId })
      .from(personReferencePhotos)
      .where(eq(personReferencePhotos.ownerUserId, input.ownerUserId));
    const personCount = ownerPhotos.filter((photo) => photo.personId === input.personId).length;
    if (personCount >= MAX_PERSON_REFERENCE_PHOTOS) {
      await queueRejectedPhoto(tx, input);
      return { inserted: false, reason: 'person_limit_reached' };
    }
    if (ownerPhotos.length >= MAX_OWNER_PERSON_REFERENCE_PHOTOS) {
      await queueRejectedPhoto(tx, input);
      return { inserted: false, reason: 'owner_limit_reached' };
    }

    const [photo] = await tx.insert(personReferencePhotos).values(input).returning();
    return { inserted: true, photo: photo! };
  });
}

export async function deletePersonReferencePhoto(
  db: Database,
  input: { ownerUserId: string; personId: string; photoId: string },
): Promise<PersonReferencePhotoRow | null> {
  return withTransaction(db, async (tx) => {
    await acquireOwnerPersonPhotoLock(tx, input.ownerUserId);
    await acquireOwnerCoverArtLock(tx, input.ownerUserId);
    const [photo] = await tx
      .delete(personReferencePhotos)
      .where(
        and(
          eq(personReferencePhotos.ownerUserId, input.ownerUserId),
          eq(personReferencePhotos.personId, input.personId),
          eq(personReferencePhotos.id, input.photoId),
        ),
      )
      .returning();
    if (!photo) return null;
    await tx.insert(deletionQueueItems).values({
      ownerUserId: input.ownerUserId,
      trackId: null,
      storageKey: photo.storageKey,
      reason: PERSON_REFERENCE_PHOTO_DELETED_REASON,
      deleteAfter: new Date(),
    });
    return photo;
  });
}
