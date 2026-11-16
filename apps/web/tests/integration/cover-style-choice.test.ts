import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  connectTestDb,
  createUser,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { updateCoverArtSettings } from '@liedmotif/db';
import { COVER_STYLE_PRESETS } from '@liedmotif/shared';
import { resolveCoverArtChoice } from '@/lib/covers';

// Start Session's cover-art resolution. The create card offers the `custom`
// choice (last in the dropdown) as an authoritative Custom state with the
// owner's own saved definition. An unset definition falls back to plain `auto` —
// cover art is cosmetic and must never block Start Session. The `random`
// choice resolves at creation to a persisted concrete style: a uniform roll
// over the preset lanes, plus `custom` when a definition is saved.

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;
const OWNER = 'owner-1';

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('cover-style-choice-test');
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, ['user_settings', 'user']);
  await createUser(testDb.db, { id: OWNER });
});

describe.skipIf(skip)('resolveCoverArtChoice', () => {
  it('resolves Custom to its authoritative saved definition', async () => {
    await updateCoverArtSettings(testDb.db, OWNER, {
      customStyleDefinition: 'Bold woodcut cover art, heavy ink outlines.',
    });

    expect(await resolveCoverArtChoice(testDb.db, OWNER, 'custom')).toEqual({
      coverStyle: 'custom',
      coverStyleHint: 'Bold woodcut cover art, heavy ink outlines.',
    });
  });

  it("resolves a Member's Custom and Random to their own definition, never the Admin's", async () => {
    const member = await createUser(testDb.db, { id: 'member-1' });
    await updateCoverArtSettings(testDb.db, OWNER, { customStyleDefinition: 'Admin ink.' });
    await updateCoverArtSettings(testDb.db, member, {
      customStyleDefinition: 'Member watercolor.',
    });

    expect(await resolveCoverArtChoice(testDb.db, member, 'custom')).toEqual({
      coverStyle: 'custom',
      coverStyleHint: 'Member watercolor.',
    });
    expect(await resolveCoverArtChoice(testDb.db, member, 'random', () => 0.999)).toEqual({
      coverStyle: 'custom',
      coverStyleHint: 'Member watercolor.',
    });
  });

  it('falls back to plain auto when no Custom style definition is saved', async () => {
    expect(await resolveCoverArtChoice(testDb.db, OWNER, 'custom')).toEqual({ coverStyle: 'auto' });
  });

  it('passes an art-direction lane through unchanged, never attaching the saved definition', async () => {
    await updateCoverArtSettings(testDb.db, OWNER, { customStyleDefinition: 'Bold comic ink.' });

    expect(await resolveCoverArtChoice(testDb.db, OWNER, 'drawing')).toEqual({
      coverStyle: 'drawing',
    });
    expect(await resolveCoverArtChoice(testDb.db, OWNER, undefined)).toEqual({});
  });

  it('resolves Random to a uniform roll over the preset lanes', async () => {
    const rolled = await Promise.all(
      COVER_STYLE_PRESETS.map((_, index) =>
        resolveCoverArtChoice(testDb.db, OWNER, 'random', () => index / COVER_STYLE_PRESETS.length),
      ),
    );

    expect(rolled).toEqual(COVER_STYLE_PRESETS.map((coverStyle) => ({ coverStyle })));
  });

  it('includes Custom (with its saved definition) in the Random pool once one is saved', async () => {
    await updateCoverArtSettings(testDb.db, OWNER, {
      customStyleDefinition: 'Bold woodcut cover art.',
    });

    expect(await resolveCoverArtChoice(testDb.db, OWNER, 'random', () => 0.999)).toEqual({
      coverStyle: 'custom',
      coverStyleHint: 'Bold woodcut cover art.',
    });
    expect(await resolveCoverArtChoice(testDb.db, OWNER, 'random', () => 0)).toEqual({
      coverStyle: COVER_STYLE_PRESETS[0],
    });
  });

  it('never rolls Custom while no definition is saved', async () => {
    expect(await resolveCoverArtChoice(testDb.db, OWNER, 'random', () => 0.999)).toEqual({
      coverStyle: COVER_STYLE_PRESETS[COVER_STYLE_PRESETS.length - 1],
    });
  });
});
