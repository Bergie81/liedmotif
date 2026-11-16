import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  connectTestDb,
  createUser,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';
import { listenerProfiles, user } from '../schema';

// Migration 0101 holds every stored User name and Short description to the
// 80-character cap the profile route enforces, so a value saved under an earlier,
// longer cap never blocks the next profile save. The shipped SQL itself runs here.
const MIGRATION_SQL = readFileSync(
  new URL('../../drizzle/0101_profile_field_caps.sql', import.meta.url),
  'utf8',
);

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('profile field caps (migration 0101)', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-profile-field-caps-migration-test');
  }, 60_000);

  afterAll(async () => {
    await ctx?.pool.end();
  });

  beforeEach(async () => {
    await truncateTables(ctx.pool, ['listener_profiles', 'user']);
  });

  async function seed(name: string, description: string | null): Promise<string> {
    const id = await createUser(ctx.db);
    await ctx.db.update(user).set({ name }).where(eq(user.id, id));
    await ctx.db.insert(listenerProfiles).values({ ownerUserId: id, description });
    return id;
  }

  async function stored(id: string) {
    const [row] = await ctx.db
      .select({ name: user.name, description: listenerProfiles.description })
      .from(user)
      .innerJoin(listenerProfiles, eq(listenerProfiles.ownerUserId, user.id))
      .where(eq(user.id, id));
    return row;
  }

  it('cuts an over-long name and description to 80 characters, without a trailing space', async () => {
    const id = await seed(
      `${'n'.repeat(79)} ${'m'.repeat(40)}`,
      `${'d'.repeat(79)} ${'e'.repeat(80)}`,
    );

    await ctx.pool.query(MIGRATION_SQL);

    expect(await stored(id)).toEqual({ name: 'n'.repeat(79), description: 'd'.repeat(79) });
  });

  it('leaves values within the cap, and an unset description, as they are', async () => {
    const fits = await seed('x'.repeat(80), 'y'.repeat(80));
    const unset = await seed('Ada', null);

    await ctx.pool.query(MIGRATION_SQL);

    expect(await stored(fits)).toEqual({ name: 'x'.repeat(80), description: 'y'.repeat(80) });
    expect(await stored(unset)).toEqual({ name: 'Ada', description: null });
  });
});
