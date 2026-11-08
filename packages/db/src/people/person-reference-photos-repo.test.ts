import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPerson, deletePerson, ensureOwnerPerson } from './people-repo';
import {
  deletePersonReferencePhoto,
  getPersonReferencePhoto,
  insertPersonReferencePhoto,
  listPersonReferencePhotos,
  PERSON_REFERENCE_PHOTO_DELETED_REASON,
} from './person-reference-photos-repo';
import { deletionQueueItems, people, personReferencePhotos, user } from '../schema';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

async function seedUser(ctx: TestDb, name: string, email: string): Promise<string> {
  const id = randomUUID();
  await ctx.db.insert(user).values({ id, name, email });
  await ensureOwnerPerson(ctx.db, id);
  return id;
}

function photoInput(ownerUserId: string, personId: string, suffix: string = randomUUID()) {
  return {
    id: randomUUID(),
    ownerUserId,
    personId,
    storageProvider: 'local-fs',
    storageKey: `person-references/${ownerUserId}/${personId}/${suffix}.webp`,
    mediaType: 'image/webp',
    originalFilename: 'portrait.jpg',
    byteSize: 128,
    width: 64,
    height: 64,
  };
}

describeIfDb('Person reference photos repository', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-person-photos-test');
  }, 60_000);

  afterAll(async () => {
    await ctx?.pool.end();
  });

  beforeEach(async () => {
    await truncateTables(ctx.pool, ['user', 'deletion_queue_items']);
  });

  it('serializes concurrent uploads at three photos per Person', async () => {
    const ownerUserId = await seedUser(ctx, 'Owner', 'owner@example.test');
    const person = await createPerson(ctx.db, { ownerUserId, name: 'Julia' });

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        insertPersonReferencePhoto(ctx.db, photoInput(ownerUserId, person.id)),
      ),
    );

    expect(results.filter((result) => result.inserted)).toHaveLength(3);
    expect(results.filter((result) => !result.inserted)).toEqual([
      { inserted: false, reason: 'person_limit_reached' },
    ]);
    expect(
      await listPersonReferencePhotos(ctx.db, { ownerUserId, personId: person.id }),
    ).toHaveLength(3);
  });

  it('enforces the 18-photo owner cap independently under concurrent uploads', async () => {
    const ownerUserId = await seedUser(ctx, 'Owner', 'owner@example.test');
    const seededPeople = Array.from({ length: 7 }, (_, index) => ({
      id: randomUUID(),
      ownerUserId,
      role: 'ordinary',
      name: `Seed Person ${index}`,
      nameMatchKey: `seed person ${index}`,
      about: '',
      sortOrder: index + 1,
    }));
    await ctx.db.insert(people).values(seededPeople);
    const distribution = [3, 3, 3, 2, 2, 2, 2];
    await ctx.db
      .insert(personReferencePhotos)
      .values(
        seededPeople.flatMap((person, personIndex) =>
          Array.from({ length: distribution[personIndex]! }, (_, photoIndex) =>
            photoInput(ownerUserId, person.id, `seed-${personIndex}-${photoIndex}`),
          ),
        ),
      );

    const results = await Promise.all([
      insertPersonReferencePhoto(
        ctx.db,
        photoInput(ownerUserId, seededPeople[3]!.id, 'concurrent-a'),
      ),
      insertPersonReferencePhoto(
        ctx.db,
        photoInput(ownerUserId, seededPeople[4]!.id, 'concurrent-b'),
      ),
    ]);

    expect(results.filter((result) => result.inserted)).toHaveLength(1);
    expect(results.filter((result) => !result.inserted)).toEqual([
      { inserted: false, reason: 'owner_limit_reached' },
    ]);
  });

  it('returns explicit missing-Person admission without creating an association', async () => {
    const ownerUserId = await seedUser(ctx, 'Owner', 'owner@example.test');
    await expect(
      insertPersonReferencePhoto(ctx.db, photoInput(ownerUserId, randomUUID())),
    ).resolves.toEqual({ inserted: false, reason: 'person_not_found' });
  });

  it('scopes identifiers to the owner and atomically queues a deleted photo', async () => {
    const ownerA = await seedUser(ctx, 'Owner A', 'a@example.test');
    const ownerB = await seedUser(ctx, 'Owner B', 'b@example.test');
    const person = await createPerson(ctx.db, { ownerUserId: ownerA, name: 'Julia' });
    const input = photoInput(ownerA, person.id);
    await insertPersonReferencePhoto(ctx.db, input);

    expect(
      await getPersonReferencePhoto(ctx.db, { ownerUserId: ownerB, photoId: input.id }),
    ).toBeNull();
    expect(
      await deletePersonReferencePhoto(ctx.db, {
        ownerUserId: ownerB,
        personId: person.id,
        photoId: input.id,
      }),
    ).toBeNull();
    expect(
      await deletePersonReferencePhoto(ctx.db, {
        ownerUserId: ownerA,
        personId: person.id,
        photoId: input.id,
      }),
    ).toMatchObject({ id: input.id, storageKey: input.storageKey });
    expect(
      await ctx.db
        .select({ storageKey: deletionQueueItems.storageKey, reason: deletionQueueItems.reason })
        .from(deletionQueueItems),
    ).toContainEqual({
      storageKey: input.storageKey,
      reason: PERSON_REFERENCE_PHOTO_DELETED_REASON,
    });
  });

  it('queues every child photo atomically when deleting an ordinary Person', async () => {
    const ownerUserId = await seedUser(ctx, 'Owner', 'owner@example.test');
    const person = await createPerson(ctx.db, { ownerUserId, name: 'Julia' });
    const photos = [photoInput(ownerUserId, person.id), photoInput(ownerUserId, person.id)];
    for (const input of photos) await insertPersonReferencePhoto(ctx.db, input);

    expect(await deletePerson(ctx.db, { ownerUserId, personId: person.id })).toBe('deleted');
    expect(
      await ctx.db
        .select({ storageKey: deletionQueueItems.storageKey })
        .from(deletionQueueItems)
        .where(eq(deletionQueueItems.reason, PERSON_REFERENCE_PHOTO_DELETED_REASON)),
    ).toEqual(expect.arrayContaining(photos.map((photo) => ({ storageKey: photo.storageKey }))));
    expect(await listPersonReferencePhotos(ctx.db, { ownerUserId, personId: person.id })).toEqual(
      [],
    );
  });
});
