// What the Assistant changes in the asking user's own settings when its model
// calls `changeSetting`, and what the reply stream then says was changed. The
// route, the tool and the app's own settings functions run against a real
// database; a scripted model stands in for the text LLM.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureOwnerPerson,
  getCoverReferenceFrequency,
  getGenerationSettings,
  getPlaybackSettings,
  insertPersonReferencePhoto,
  updateCoverReferenceFrequency,
  updateGenerationSettings,
  user,
  userProfiles,
} from '@liedmotif/db';
import {
  connectTestDb,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import {
  ASSISTANT_SETTINGS,
  changeSettingInputSchema,
  type AssistantReceipt,
} from '@liedmotif/shared';
import { askWithToolCalls, type ToolCallsTurn } from '../helpers/assistant-tool-turn';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionUserId: null as string | null,
  llm: null as unknown,
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/auth', () => ({
  getAuth: () => ({
    api: {
      getSession: async () =>
        holder.sessionUserId
          ? { session: { id: 'live' }, user: { id: holder.sessionUserId } }
          : null,
    },
  }),
}));
vi.mock('@/lib/providers/providers', () => ({
  getLlmProvider: async () => holder.llm,
  getTypicalTracksPerMusicRequest: () => 2,
}));

const { POST } = await import('@/app/api/assistant/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

/**
 * A Member named `name` under an id of their own. The route's burst limit
 * counts per user id for as long as the process lives, so no two tests share one.
 */
let members = 0;
async function createMember(name: string): Promise<string> {
  members += 1;
  const id = `${name}-${members}`;
  await testDb.db.insert(user).values({ id, name, email: `${id}@example.test` });
  await testDb.db.insert(userProfiles).values({ userId: id, role: 'member' });
  return id;
}

/** `userId`'s own card, with the reference photo that putting them on a Cover takes. */
async function photographOwner(userId: string): Promise<void> {
  const owner = await ensureOwnerPerson(testDb.db, userId);
  const id = randomUUID();
  const result = await insertPersonReferencePhoto(testDb.db, {
    id,
    ownerUserId: userId,
    personId: owner.id,
    storageProvider: 'local-fs',
    storageKey: `people/${userId}/${owner.id}/${id}.webp`,
    mediaType: 'image/webp',
    byteSize: 4,
  });
  expect(result.inserted).toBe(true);
}

/** `userId` sends one message; the model asks for `setting` to become `value`. */
function change(userId: string, setting: string, value: string): Promise<ToolCallsTurn> {
  holder.sessionUserId = userId;
  return askWithToolCalls(
    POST,
    (llm) => {
      holder.llm = llm;
    },
    [{ name: 'changeSetting', input: { setting, value } }],
  );
}

/** The receipts a reply stream carried, in order. */
const receipts = ({ events }: ToolCallsTurn): AssistantReceipt[] =>
  events.flatMap((event) =>
    event.type === 'action' && event.action.status === 'done' ? [event.action.receipt] : [],
  );

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('assistant-changes-a-setting-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, [
    'listener_profiles',
    ...GENERATION_FIXTURE_TABLES,
    'user_settings',
    'app_settings',
  ]);
  holder.sessionUserId = null;
});

describe.skipIf(skip)('the Assistant asked to change one of the asker’s own settings', () => {
  it('stores how often the owner appears on Covers and sends a receipt with the old and the new choice', async () => {
    const asker = await createMember('member');
    await photographOwner(asker);
    await updateCoverReferenceFrequency(testDb.db, asker, 'always');

    const turn = await change(asker, 'ownerInCovers', 'seldom');

    expect(await getCoverReferenceFrequency(testDb.db, asker)).toBe('seldom');
    expect(receipts(turn)).toEqual([
      { action: 'changeSetting', setting: 'ownerInCovers', value: 'Seldom', previous: 'Always' },
    ]);
    expect(turn.results[0]).toBe(
      'Done: changed the setting "Include the owner in covers" from Always to Seldom.',
    );
    expect(turn.events.at(-1)).toEqual({ type: 'done' });
  });

  it('changes nothing for a choice the setting does not have, and tells the model its choices', async () => {
    const asker = await createMember('member');
    await photographOwner(asker);
    await updateCoverReferenceFrequency(testDb.db, asker, 'always');

    const turn = await change(asker, 'ownerInCovers', 'sometimes');

    expect(await getCoverReferenceFrequency(testDb.db, asker)).toBe('always');
    expect(receipts(turn)).toEqual([]);
    expect(turn.results[0]).toBe(
      '"Include the owner in covers" takes Always, Regularly, Seldom or Never. Nothing was changed.',
    );
  });

  it('sends no receipt when the setting already holds that choice', async () => {
    const asker = await createMember('member');
    await photographOwner(asker);
    await updateCoverReferenceFrequency(testDb.db, asker, 'seldom');

    const turn = await change(asker, 'ownerInCovers', 'Seldom');

    expect(receipts(turn)).toEqual([]);
    expect(turn.results[0]).toBe(
      '"Include the owner in covers" is already Seldom. Nothing was changed.',
    );
  });

  it('leaves every other user’s setting as it is', async () => {
    const asker = await createMember('member');
    const other = await createMember('other');
    await photographOwner(asker);
    await updateCoverReferenceFrequency(testDb.db, other, 'always');

    await change(asker, 'ownerInCovers', 'never');

    expect(await getCoverReferenceFrequency(testDb.db, asker)).toBe('never');
    expect(await getCoverReferenceFrequency(testDb.db, other)).toBe('always');
  });

  it('leaves the owner off Covers until their own card has a reference photo, as the People page does', async () => {
    const asker = await createMember('member');
    await ensureOwnerPerson(testDb.db, asker);
    await updateCoverReferenceFrequency(testDb.db, asker, 'regularly');

    const turn = await change(asker, 'ownerInCovers', 'always');

    expect(await getCoverReferenceFrequency(testDb.db, asker)).toBe('regularly');
    expect(receipts(turn)).toEqual([]);
    expect(turn.results[0]).toBe(
      '"Include the owner in covers" stays at Never until the user\'s own card in Settings › People has a reference photo: they add one there first. Nothing was changed.',
    );
  });

  it('switches blending between Tracks on and off', async () => {
    const asker = await createMember('member');

    const turn = await change(asker, 'blend', 'off');

    expect(await getPlaybackSettings(testDb.db, asker)).toMatchObject({ blendEnabled: false });
    expect(receipts(turn)).toEqual([
      { action: 'changeSetting', setting: 'blend', value: 'Off', previous: 'On' },
    ]);
    expect(turn.results[0]).toBe(
      'Done: changed the setting "Blend consecutive tracks" from On to Off.',
    );
  });

  it('sets the crossfade length in whole seconds', async () => {
    const asker = await createMember('member');

    const turn = await change(asker, 'crossfadeSeconds', '9');

    expect(await getPlaybackSettings(testDb.db, asker)).toEqual({
      blendEnabled: true,
      crossfadeSeconds: 9,
    });
    expect(receipts(turn)).toEqual([
      { action: 'changeSetting', setting: 'crossfadeSeconds', value: '9 s', previous: '6 s' },
    ]);
  });

  it.each(['8 s', '8 seconds', '8sec'])(
    'takes the crossfade length with its unit: "%s"',
    async (said) => {
      const asker = await createMember('member');

      await change(asker, 'crossfadeSeconds', said);

      expect(await getPlaybackSettings(testDb.db, asker)).toMatchObject({ crossfadeSeconds: 8 });
    },
  );

  it.each(['1', '13', '4.5', 'long', '8 minutes'])(
    'keeps the crossfade length for "%s", which its slider does not have',
    async (said) => {
      const asker = await createMember('member');

      const turn = await change(asker, 'crossfadeSeconds', said);

      expect(await getPlaybackSettings(testDb.db, asker)).toMatchObject({ crossfadeSeconds: 6 });
      expect(receipts(turn)).toEqual([]);
      expect(turn.results[0]).toBe(
        '"Crossfade length" takes a whole number of seconds from 2 to 12. Nothing was changed.',
      );
    },
  );

  it('sets the default language, and leaves what the Generation settings spend as it is', async () => {
    const asker = await createMember('member');
    await updateGenerationSettings(testDb.db, {
      ownerUserId: asker,
      patch: { bufferEnabled: false, bufferAheadTracks: 2 },
    });

    const turn = await change(asker, 'defaultLanguage', 'german');

    expect(await getGenerationSettings(testDb.db, asker)).toEqual({
      bufferEnabled: false,
      bufferAheadTracks: 2,
      defaultLanguage: 'German',
    });
    expect(receipts(turn)).toEqual([
      {
        action: 'changeSetting',
        setting: 'defaultLanguage',
        value: 'German',
        previous: 'Auto Detect',
      },
    ]);
  });

  it('takes a language by the name its select shows, Auto Detect included', async () => {
    const asker = await createMember('member');

    await change(asker, 'defaultLanguage', 'Chinese (Mandarin)');
    expect(await getGenerationSettings(testDb.db, asker)).toMatchObject({
      defaultLanguage: 'Chinese',
    });

    await change(asker, 'defaultLanguage', 'auto detect');
    expect(await getGenerationSettings(testDb.db, asker)).toMatchObject({
      defaultLanguage: 'auto',
    });
  });
});

describe('the settings the Assistant changes', () => {
  it('are the four that cannot spend, and the tool takes no other', () => {
    expect(ASSISTANT_SETTINGS).toEqual([
      'ownerInCovers',
      'blend',
      'crossfadeSeconds',
      'defaultLanguage',
    ]);
    for (const setting of ['bufferAheadTracks', 'bufferEnabled', 'dailyTrackLimit']) {
      expect(changeSettingInputSchema.safeParse({ setting, value: '10' }).success).toBe(false);
    }
  });
});
