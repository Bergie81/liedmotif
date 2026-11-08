import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { user } from '../schema';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import {
  countPeople,
  createPerson,
  deletePerson,
  ensureOwnerPerson,
  listPeople,
  PersonLimitError,
  PersonNameConflictError,
  updatePerson,
} from './people-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

async function seedUser(ctx: TestDb, name: string, email: string): Promise<string> {
  const id = randomUUID();
  await ctx.db.insert(user).values({ id, name, email });
  return id;
}

describeIfDb('People repository', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-people-test');
  }, 60_000);

  afterAll(async () => {
    await ctx?.pool.end();
  });

  beforeEach(async () => {
    await truncateTables(ctx.pool, ['user']);
  });

  it('provisions exactly one owner Person from the User name and lists the owner first', async () => {
    const ownerUserId = await seedUser(ctx, 'John', 'owner@example.test');

    const first = await ensureOwnerPerson(ctx.db, ownerUserId);
    const retried = await ensureOwnerPerson(ctx.db, ownerUserId);
    await createPerson(ctx.db, { ownerUserId, name: 'Amina', about: 'Climbs and paints.' });

    expect(retried.id).toBe(first.id);
    expect(await listPeople(ctx.db, ownerUserId)).toMatchObject([
      { id: first.id, role: 'owner', name: 'John', about: '' },
      { role: 'ordinary', name: 'Amina', about: 'Climbs and paints.' },
    ]);
  });

  it('counts People per owner, matching the list length', async () => {
    const ownerA = await seedUser(ctx, 'Owner A', 'a@example.test');
    const ownerB = await seedUser(ctx, 'Owner B', 'b@example.test');
    await Promise.all([ensureOwnerPerson(ctx.db, ownerA), ensureOwnerPerson(ctx.db, ownerB)]);
    await createPerson(ctx.db, { ownerUserId: ownerA, name: 'Julia' });

    expect(await countPeople(ctx.db, ownerA)).toBe((await listPeople(ctx.db, ownerA)).length);
    expect(await countPeople(ctx.db, ownerA)).toBe(2);
    expect(await countPeople(ctx.db, ownerB)).toBe(1);
  });

  it('keeps User and owner Person names independent after provisioning', async () => {
    const ownerUserId = await seedUser(ctx, 'John', 'owner@example.test');
    const owner = await ensureOwnerPerson(ctx.db, ownerUserId);

    await updatePerson(ctx.db, {
      ownerUserId,
      personId: owner.id,
      name: 'Tom',
      about: 'Trail runner.',
    });
    await ctx.db.update(user).set({ name: 'John Updated' });

    await ensureOwnerPerson(ctx.db, ownerUserId);
    expect(await listPeople(ctx.db, ownerUserId)).toMatchObject([
      { id: owner.id, name: 'Tom', about: 'Trail runner.' },
    ]);
  });

  it('rejects canonical duplicate names per owner while allowing them for another owner', async () => {
    const ownerA = await seedUser(ctx, 'Owner A', 'a@example.test');
    const ownerB = await seedUser(ctx, 'Owner B', 'b@example.test');
    await Promise.all([ensureOwnerPerson(ctx.db, ownerA), ensureOwnerPerson(ctx.db, ownerB)]);

    await createPerson(ctx.db, { ownerUserId: ownerA, name: 'José' });
    await expect(
      createPerson(ctx.db, { ownerUserId: ownerA, name: ' JOSE\u0301 ' }),
    ).rejects.toBeInstanceOf(PersonNameConflictError);
    await expect(
      createPerson(ctx.db, { ownerUserId: ownerA, name: 'STRAẞE' }),
    ).resolves.toBeTruthy();
    await expect(
      createPerson(ctx.db, { ownerUserId: ownerA, name: 'strasse' }),
    ).rejects.toBeInstanceOf(PersonNameConflictError);
    await expect(createPerson(ctx.db, { ownerUserId: ownerB, name: 'José' })).resolves.toBeTruthy();
  });

  it('serializes concurrent creates so an owner never exceeds six People', async () => {
    const ownerUserId = await seedUser(ctx, 'Owner', 'owner@example.test');
    await ensureOwnerPerson(ctx.db, ownerUserId);

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        createPerson(ctx.db, { ownerUserId, name: `Person ${index + 1}` }),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(PersonLimitError);
    expect(await listPeople(ctx.db, ownerUserId)).toHaveLength(6);
  });

  it('scopes updates and deletes to the owner and never deletes the owner Person', async () => {
    const ownerA = await seedUser(ctx, 'Owner A', 'a@example.test');
    const ownerB = await seedUser(ctx, 'Owner B', 'b@example.test');
    const ownerPerson = await ensureOwnerPerson(ctx.db, ownerA);
    await ensureOwnerPerson(ctx.db, ownerB);
    const person = await createPerson(ctx.db, { ownerUserId: ownerA, name: 'Julia' });

    await expect(
      updatePerson(ctx.db, {
        ownerUserId: ownerB,
        personId: person.id,
        name: 'Stolen',
        about: '',
      }),
    ).resolves.toBeNull();
    await expect(deletePerson(ctx.db, { ownerUserId: ownerB, personId: person.id })).resolves.toBe(
      'not_found',
    );
    await expect(
      deletePerson(ctx.db, { ownerUserId: ownerA, personId: ownerPerson.id }),
    ).resolves.toBe('owner');
    await expect(deletePerson(ctx.db, { ownerUserId: ownerA, personId: person.id })).resolves.toBe(
      'deleted',
    );
  });
});
