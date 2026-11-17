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
import { appSettings, userProfiles } from '../schema';
import { getCoverArtSettings } from './user-settings-repo';

// Migration 0100 hands the instance-wide cover-art preferences to the Admin, the
// only User who could have written them, and drops the instance row so no
// reader can fall back to it. The shipped SQL itself runs here.
const MIGRATION_SQL = readFileSync(
  new URL('../../drizzle/0100_per_user_cover_art.sql', import.meta.url),
  'utf8',
);

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('per-user cover art (migration 0100)', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-per-user-cover-art-migration-test');
  }, 60_000);

  afterAll(async () => {
    await ctx?.pool.end();
  });

  beforeEach(async () => {
    await truncateTables(ctx.pool, ['app_settings', 'user_settings', 'user']);
  });

  async function seedAdminAndMember() {
    const admin = await createUser(ctx.db);
    const member = await createUser(ctx.db);
    await ctx.db.insert(userProfiles).values([
      { userId: admin, role: 'admin' },
      { userId: member, role: 'member' },
    ]);
    return { admin, member };
  }

  it("moves the instance cover-art settings onto the Admin's own", async () => {
    const { admin, member } = await seedAdminAndMember();
    await ctx.db.insert(appSettings).values({
      key: 'coverArt',
      value: {
        defaultStyle: 'minimal',
        customStyleDefinition: 'Bold comic ink.',
        promptEnhancementEnabled: false,
      },
    });

    await ctx.pool.query(MIGRATION_SQL);

    expect(await getCoverArtSettings(ctx.db, admin)).toEqual({
      defaultStyle: 'minimal',
      customStyleDefinition: 'Bold comic ink.',
      useStandardCoverArt: false,
      promptEnhancementEnabled: false,
    });
    expect((await getCoverArtSettings(ctx.db, member)).customStyleDefinition).toBe('');
    expect(await ctx.db.select().from(appSettings).where(eq(appSettings.key, 'coverArt'))).toEqual(
      [],
    );
  });

  it('leaves the Admin on the defaults when nothing was saved', async () => {
    const { admin } = await seedAdminAndMember();

    await ctx.pool.query(MIGRATION_SQL);

    expect(await getCoverArtSettings(ctx.db, admin)).toEqual({
      defaultStyle: 'auto',
      customStyleDefinition: '',
      useStandardCoverArt: false,
      promptEnhancementEnabled: true,
    });
  });
});
