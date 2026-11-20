import { and, asc, eq, max, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { canonicalPersonName } from '@liedmotif/shared';
import type { Database } from '../client';
import { sqlState } from '../pg-errors';
import { acquireOwnerCoverArtLock } from '../covers/generated-repo';
import { deletionQueueItems, people, personReferencePhotos, user } from '../schema';
import { withTransaction, type DbOrTx, type Transaction } from '../transactions';
import { OWNER_PEOPLE_LOCK_CLASS } from '../advisory-locks';
import {
  acquireOwnerPersonPhotoLock,
  PERSON_REFERENCE_PHOTO_DELETED_REASON,
} from './person-reference-photos-repo';

export const MAX_PEOPLE_PER_OWNER = 6;
export const MAX_PERSON_NAME_LENGTH = 120;
export const MAX_PERSON_ABOUT_LENGTH = 2_000;

/**
 * What the owner Person is called while the User has no name of their own — setup
 * asks only for a login, so the card exists before onboarding asks who the owner is.
 * A Person carrying it has never been named, which is what lets the first name typed
 * in onboarding still travel onto it.
 */
export const OWNER_PERSON_FALLBACK_NAME = 'Owner';

export type PersonRow = typeof people.$inferSelect;

export class PersonLimitError extends Error {
  constructor() {
    super(`Each owner may configure at most ${MAX_PEOPLE_PER_OWNER} people.`);
    this.name = 'PersonLimitError';
  }
}

export class PersonNameConflictError extends Error {
  constructor() {
    super('Each person needs a unique name.');
    this.name = 'PersonNameConflictError';
  }
}

export class PersonValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersonValidationError';
  }
}

function personValues(
  name: string,
  about = '',
): { name: string; nameMatchKey: string; about: string } {
  const normalizedName = name.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const normalizedAbout = about.trim();
  if (!normalizedName) throw new PersonValidationError('Enter a person name.');
  if (normalizedName.length > MAX_PERSON_NAME_LENGTH) {
    throw new PersonValidationError(
      `Person names must be at most ${MAX_PERSON_NAME_LENGTH} characters.`,
    );
  }
  if (normalizedAbout.length > MAX_PERSON_ABOUT_LENGTH) {
    throw new PersonValidationError(`About must be at most ${MAX_PERSON_ABOUT_LENGTH} characters.`);
  }
  return {
    name: normalizedName,
    nameMatchKey: canonicalPersonName(normalizedName),
    about: normalizedAbout,
  };
}

async function acquireOwnerPeopleLock(tx: Transaction, ownerUserId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${OWNER_PEOPLE_LOCK_CLASS}, hashtext(${ownerUserId}))`,
  );
}

export async function listPeople(db: DbOrTx, ownerUserId: string): Promise<PersonRow[]> {
  return db
    .select()
    .from(people)
    .where(eq(people.ownerUserId, ownerUserId))
    .orderBy(asc(people.sortOrder), asc(people.createdAt), asc(people.id));
}

export async function countPeople(db: DbOrTx, ownerUserId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(people)
    .where(eq(people.ownerUserId, ownerUserId));
  return row?.count ?? 0;
}

/** Provision the immutable owner role once; subsequent User-name edits never resync it. */
export async function ensureOwnerPerson(db: Database, ownerUserId: string): Promise<PersonRow> {
  return withTransaction(db, (tx) => ensureOwnerPersonInTx(tx, ownerUserId));
}

/**
 * The composable form, for callers that must pair the owner Person with other
 * writes atomically (account creation: `createAdminProfile`'s pairing, and the
 * invite claim). Takes the owner-people advisory lock inside the caller's
 * transaction.
 */
export async function ensureOwnerPersonInTx(
  tx: Transaction,
  ownerUserId: string,
): Promise<PersonRow> {
  await acquireOwnerPeopleLock(tx, ownerUserId);
  const [existing] = await tx
    .select()
    .from(people)
    .where(and(eq(people.ownerUserId, ownerUserId), eq(people.role, 'owner')))
    .limit(1);
  if (existing) return existing;

  const [owner] = await tx
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, ownerUserId))
    .limit(1);
  if (!owner) throw new PersonValidationError('Cannot provision a Person for an unknown User.');
  const values = personValues(owner.name || OWNER_PERSON_FALLBACK_NAME);
  const [inserted] = await tx
    .insert(people)
    .values({ ownerUserId, role: 'owner', sortOrder: 0, ...values })
    .returning();
  return inserted!;
}

export async function createPerson(
  db: Database,
  input: { ownerUserId: string; name: string; about?: string },
): Promise<PersonRow> {
  const values = personValues(input.name, input.about);
  try {
    return await withTransaction(db, async (tx) => {
      await acquireOwnerPeopleLock(tx, input.ownerUserId);
      const existing = await tx
        .select({ id: people.id })
        .from(people)
        .where(eq(people.ownerUserId, input.ownerUserId));
      if (existing.length >= MAX_PEOPLE_PER_OWNER) throw new PersonLimitError();

      const [order] = await tx
        .select({ value: max(people.sortOrder) })
        .from(people)
        .where(eq(people.ownerUserId, input.ownerUserId));
      const [inserted] = await tx
        .insert(people)
        .values({
          ownerUserId: input.ownerUserId,
          role: 'ordinary',
          sortOrder: (order?.value ?? 0) + 1,
          ...values,
        })
        .returning();
      return inserted!;
    });
  } catch (error) {
    if (sqlState(error) === '23505') throw new PersonNameConflictError();
    throw error;
  }
}

export async function updatePerson(
  db: Database,
  input: { ownerUserId: string; personId: string; name: string; about: string },
): Promise<PersonRow | null> {
  const values = personValues(input.name, input.about);
  try {
    const [updated] = await db
      .update(people)
      .set(values)
      .where(and(eq(people.ownerUserId, input.ownerUserId), eq(people.id, input.personId)))
      .returning();
    return updated ?? null;
  } catch (error) {
    if (sqlState(error) === '23505') throw new PersonNameConflictError();
    throw error;
  }
}

/**
 * Carry a User-name change onto the owner Person, but only while that Person has
 * never been given a name of its own.
 *
 * The owner Person is created from the User name and thereafter edited
 * independently. Matching on the name being replaced is what distinguishes
 * "never diverged, so follow the User" from "deliberately different, so leave
 * alone" — and it is what lets first-login onboarding introduce the owner by
 * the name they just typed instead of by whatever name setup gave the User.
 *
 * Best-effort by design: a User name a Person could not legally carry, or one that
 * another Person already answers to, leaves the owner card alone rather than failing
 * the profile save. The collision is excluded in the WHERE clause rather than caught
 * afterwards, because the caller's transaction also carries the profile write — a
 * raised unique violation would poison it. Only the name moves; About text and
 * photos are the Person's own.
 */
export async function renameOwnerPersonFollowingUser(
  tx: DbOrTx,
  input: { ownerUserId: string; previousUserName: string; nextUserName: string },
): Promise<void> {
  // A nameless User's Person carries the provisioning fallback, which is equally
  // "never given a name of its own" — so that is the name being replaced. The
  // Person stored the User name through `personValues`, so the match normalizes it
  // the same way.
  const previous =
    input.previousUserName.normalize('NFKC').replace(/\s+/gu, ' ').trim() ||
    OWNER_PERSON_FALLBACK_NAME;
  if (!input.nextUserName.trim() || input.nextUserName.trim() === previous) return;
  let named: { name: string; nameMatchKey: string };
  try {
    const values = personValues(input.nextUserName);
    named = { name: values.name, nameMatchKey: values.nameMatchKey };
  } catch (error) {
    if (error instanceof PersonValidationError) return;
    throw error;
  }
  const taken = tx
    .select({ one: sql`1` })
    .from(alias(people, 'other'))
    .where(
      and(
        eq(sql`other.owner_user_id`, input.ownerUserId),
        eq(sql`other.name_match_key`, named.nameMatchKey),
        sql`other.id <> ${people.id}`,
      ),
    );
  await tx
    .update(people)
    .set(named)
    .where(
      and(
        eq(people.ownerUserId, input.ownerUserId),
        eq(people.role, 'owner'),
        eq(people.name, previous),
        notExists(taken),
      ),
    );
}

export async function deletePerson(
  db: Database,
  input: { ownerUserId: string; personId: string },
): Promise<'deleted' | 'not_found' | 'owner'> {
  return withTransaction(db, async (tx) => {
    await acquireOwnerPeopleLock(tx, input.ownerUserId);
    const [person] = await tx
      .select({ role: people.role })
      .from(people)
      .where(and(eq(people.ownerUserId, input.ownerUserId), eq(people.id, input.personId)))
      .limit(1);
    if (!person) return 'not_found';
    if (person.role === 'owner') return 'owner';
    await acquireOwnerPersonPhotoLock(tx, input.ownerUserId);
    await acquireOwnerCoverArtLock(tx, input.ownerUserId);
    const photos = await tx
      .select({ storageKey: personReferencePhotos.storageKey })
      .from(personReferencePhotos)
      .where(
        and(
          eq(personReferencePhotos.ownerUserId, input.ownerUserId),
          eq(personReferencePhotos.personId, input.personId),
        ),
      );
    if (photos.length > 0) {
      await tx.insert(deletionQueueItems).values(
        photos.map((photo) => ({
          ownerUserId: input.ownerUserId,
          trackId: null,
          storageKey: photo.storageKey,
          reason: PERSON_REFERENCE_PHOTO_DELETED_REASON,
          deleteAfter: new Date(),
        })),
      );
    }
    await tx
      .delete(people)
      .where(and(eq(people.ownerUserId, input.ownerUserId), eq(people.id, input.personId)));
    return 'deleted';
  });
}
