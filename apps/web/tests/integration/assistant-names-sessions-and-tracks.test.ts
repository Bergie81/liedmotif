// What the Assistant does when its model asks to rename or pin a Session of
// the asking user's, or to rename one of their Tracks, and what the reply
// stream then says was done. The route, the tools and the app's own rename and
// pin functions run against a real database; a scripted model stands in for
// the text LLM, and the retag of downloaded files is caught where it is asked for.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activitySessions,
  addPlaylistTracks,
  createPlaylist,
  getOwnedTrackSummary,
  getSessionById,
  setPlaylistShared,
  setSessionPinned,
  user,
  userProfiles,
} from '@liedmotif/db';
import {
  connectTestDb,
  createSession,
  GENERATION_FIXTURE_TABLES,
  seedSessionTrack,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import {
  MAX_PINNED_SESSIONS,
  type AssistantPlayerState,
  type AssistantReceipt,
} from '@liedmotif/shared';
import { askWithToolCalls, type ToolCallsTurn } from '../helpers/assistant-tool-turn';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionUserId: null as string | null,
  llm: null as unknown,
  retagged: [] as string[],
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
vi.mock('@/lib/worker-jobs', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/worker-jobs')>()),
  enqueueEmbedTrackMetadataBatch: async (_db: unknown, trackIds: string[]) => {
    holder.retagged.push(...trackIds);
  },
}));

const { POST } = await import('@/app/api/assistant/route');
const { loadSessionList } = await import('@/lib/sessions/sessions');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

const UNKNOWN_ID = '7b0a1c5e-3f0d-4a55-9d0e-2f6f3f1f8a11';

/**
 * A Member under an id of their own. The route's burst limit counts per user
 * id for as long as the process lives, so no two tests share one.
 */
let members = 0;
async function createMember(): Promise<string> {
  members += 1;
  const id = `namer-${members}`;
  await testDb.db.insert(user).values({ id, name: 'Namer', email: `${id}@example.test` });
  await testDb.db.insert(userProfiles).values({ userId: id, role: 'member' });
  return id;
}

/** A stopped Session of `ownerUserId` with one downloaded Track and one that only streams. */
async function seedSession(ownerUserId: string, title: string | null) {
  const sessionId = await createSession(testDb.db, { ownerUserId, title, status: 'stopped' });
  const downloaded = await seedSessionTrack(testDb.db, ownerUserId, sessionId, {
    title: 'Night Drive',
  });
  const streamOnly = await seedSessionTrack(testDb.db, ownerUserId, sessionId, {
    title: 'Open Road',
    playable: false,
  });
  return { sessionId, downloaded, streamOnly };
}

async function markDeleting(sessionId: string) {
  await testDb.db
    .update(activitySessions)
    .set({ deleteRequestedAt: new Date() })
    .where(eq(activitySessions.id, sessionId));
}

/** `userId` sends one message; the model calls every one of `calls` at once. */
function act(
  userId: string,
  calls: { name: string; input: unknown }[],
  player?: AssistantPlayerState,
): Promise<ToolCallsTurn> {
  holder.sessionUserId = userId;
  return askWithToolCalls(
    POST,
    (llm) => {
      holder.llm = llm;
    },
    calls,
    { player },
  );
}

/** The receipts a reply stream carried, in order. */
const receipts = ({ events }: ToolCallsTurn): AssistantReceipt[] =>
  events.flatMap((event) =>
    event.type === 'action' && event.action.status === 'done' ? [event.action.receipt] : [],
  );

const sessionName = async (ownerUserId: string, sessionId: string) =>
  (await getSessionById(testDb.db, { ownerUserId, sessionId }))?.title;

const trackTitle = async (ownerUserId: string, trackId: string) =>
  (await getOwnedTrackSummary(testDb.db, { ownerUserId, trackId }))?.title;

/** The ids of `ownerUserId`'s pinned Sessions, as My Sessions lists them. */
async function pinnedSessions(ownerUserId: string): Promise<string[]> {
  const list = await loadSessionList(testDb.db as never, ownerUserId, {
    limit: 20,
    includeActive: true,
    includePinned: true,
  });
  return list.pinned.map(({ id }) => id);
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('assistant-names-sessions-and-tracks-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, [
    'playlist_pins',
    'playlist_tracks',
    'playlists',
    ...GENERATION_FIXTURE_TABLES,
    'user_settings',
    'app_settings',
  ]);
  holder.sessionUserId = null;
  holder.retagged = [];
});

describe.skipIf(skip)('the Assistant asked to rename a Session', () => {
  it('gives it the name, retags its downloaded Tracks, and sends a receipt with the name it had', async () => {
    const asker = await createMember();
    const { sessionId, downloaded } = await seedSession(asker, 'Rainy Window');

    const turn = await act(asker, [
      { name: 'renameSession', input: { sessionId, name: '  Sunday Coffee ' } },
    ]);

    expect(await sessionName(asker, sessionId)).toBe('Sunday Coffee');
    expect(holder.retagged).toEqual([downloaded]);
    expect(receipts(turn)).toEqual([
      {
        action: 'renameSession',
        session: { id: sessionId, name: 'Sunday Coffee' },
        previousName: 'Rainy Window',
      },
    ]);
    expect(turn.results[0]).toBe(
      `Done: renamed the Session "Rainy Window" to "Sunday Coffee" (id ${sessionId}).`,
    );
  });

  it('takes "this" from the Session the player has on when the model names none', async () => {
    const asker = await createMember();
    const { sessionId, downloaded } = await seedSession(asker, 'Rainy Window');

    const turn = await act(asker, [{ name: 'renameSession', input: { name: 'Sunday Coffee' } }], {
      source: { kind: 'session', id: sessionId },
      trackId: downloaded,
      playing: true,
    });

    expect(await sessionName(asker, sessionId)).toBe('Sunday Coffee');
    expect(receipts(turn)).toMatchObject([{ session: { id: sessionId, name: 'Sunday Coffee' } }]);
  });

  it('tells the model to ask when no Session is named and the player has none on', async () => {
    const asker = await createMember();
    const { sessionId } = await seedSession(asker, 'Rainy Window');
    const playlist = await createPlaylist(testDb.db, { ownerUserId: asker, name: 'Running' });

    for (const player of [
      undefined,
      { source: { kind: 'playlist' as const, id: playlist.id }, trackId: null, playing: true },
    ]) {
      const turn = await act(asker, [{ name: 'renameSession', input: { name: 'Sunday' } }], player);

      expect(turn.results[0]).toMatch(/no session is playing.*ask the user which session/i);
      expect(receipts(turn)).toEqual([]);
    }
    expect(await sessionName(asker, sessionId)).toBe('Rainy Window');
  });

  it('refuses another user’s Session, one being deleted and a text that is no id alike', async () => {
    const asker = await createMember();
    const other = await createMember();
    const theirs = await seedSession(other, 'Private');
    const deleting = await seedSession(asker, 'Leaving');
    await markDeleting(deleting.sessionId);

    const turn = await act(
      asker,
      [theirs.sessionId, deleting.sessionId, 'focus'].map((sessionId) => ({
        name: 'renameSession',
        input: { sessionId, name: 'Mine Now' },
      })),
    );

    expect(new Set(turn.results)).toEqual(
      new Set(['No Session with that id. Nothing was changed.']),
    );
    expect(receipts(turn)).toEqual([]);
    expect(await sessionName(other, theirs.sessionId)).toBe('Private');
    expect(await sessionName(asker, deleting.sessionId)).toBe('Leaving');
    expect(holder.retagged).toEqual([]);
  });

  it('refuses a name the app would not take, and says why', async () => {
    const asker = await createMember();
    const { sessionId } = await seedSession(asker, 'Rainy Window');

    const turn = await act(asker, [
      { name: 'renameSession', input: { sessionId, name: '   ' } },
      { name: 'renameSession', input: { sessionId, name: 'x'.repeat(61) } },
    ]);

    expect(turn.results).toEqual([
      'A Session name has 1 to 60 characters. Nothing was changed.',
      'A Session name has 1 to 60 characters. Nothing was changed.',
    ]);
    expect(receipts(turn)).toEqual([]);
    expect(await sessionName(asker, sessionId)).toBe('Rainy Window');
  });
});

describe.skipIf(skip)('the Assistant asked to pin a Session', () => {
  it('pins it, so My Sessions lists it among the pinned ones, and sends a receipt naming it', async () => {
    const asker = await createMember();
    const { sessionId } = await seedSession(asker, 'Rainy Window');

    const turn = await act(asker, [{ name: 'pinSession', input: { sessionId } }]);

    expect(await pinnedSessions(asker)).toEqual([sessionId]);
    expect(receipts(turn)).toEqual([
      { action: 'pinSession', session: { id: sessionId, name: 'Rainy Window' } },
    ]);
    expect(turn.results[0]).toBe(`Done: pinned the Session "Rainy Window" (id ${sessionId}).`);
  });

  it('takes "this" from the Session the player has on, and asks when there is none', async () => {
    const asker = await createMember();
    const { sessionId } = await seedSession(asker, 'Rainy Window');

    const nothingOn = await act(asker, [{ name: 'pinSession', input: {} }]);
    expect(nothingOn.results[0]).toMatch(/no session is playing.*ask the user which session/i);
    expect(await pinnedSessions(asker)).toEqual([]);

    const turn = await act(asker, [{ name: 'pinSession', input: {} }], {
      source: { kind: 'session', id: sessionId },
      trackId: null,
      playing: false,
    });
    expect(await pinnedSessions(asker)).toEqual([sessionId]);
    expect(receipts(turn)).toMatchObject([{ action: 'pinSession', session: { id: sessionId } }]);
  });

  it('gives the model the app’s own refusal once the most Sessions are pinned', async () => {
    const asker = await createMember();
    for (let index = 0; index < MAX_PINNED_SESSIONS; index += 1) {
      const pinned = await createSession(testDb.db, { ownerUserId: asker, status: 'stopped' });
      await setSessionPinned(testDb.db, { ownerUserId: asker, sessionId: pinned, pinned: true });
    }
    const { sessionId } = await seedSession(asker, 'One Too Many');

    const turn = await act(asker, [{ name: 'pinSession', input: { sessionId } }]);

    expect(turn.results[0]).toBe(
      `You can pin up to ${MAX_PINNED_SESSIONS} Sessions. Unpin one to pin another. Nothing was changed.`,
    );
    expect(receipts(turn)).toEqual([]);
    expect(await pinnedSessions(asker)).not.toContain(sessionId);
  });

  it('refuses another user’s Session and one being deleted like an id that names nothing', async () => {
    const asker = await createMember();
    const other = await createMember();
    const theirs = await seedSession(other, 'Private');
    const deleting = await seedSession(asker, 'Leaving');
    await markDeleting(deleting.sessionId);

    const turn = await act(
      asker,
      [theirs.sessionId, deleting.sessionId, UNKNOWN_ID].map((sessionId) => ({
        name: 'pinSession',
        input: { sessionId },
      })),
    );

    expect(new Set(turn.results)).toEqual(
      new Set(['No Session with that id. Nothing was changed.']),
    );
    expect(receipts(turn)).toEqual([]);
    expect(await pinnedSessions(other)).toEqual([]);
  });
});

describe.skipIf(skip)('the Assistant asked to rename a Track', () => {
  it('gives it the title, retags its file, and sends a receipt with the title it had', async () => {
    const asker = await createMember();
    const { downloaded } = await seedSession(asker, 'Rainy Window');

    const turn = await act(asker, [
      { name: 'renameTrack', input: { trackId: downloaded, name: 'Harbor Lights' } },
    ]);

    expect(await trackTitle(asker, downloaded)).toBe('Harbor Lights');
    expect(holder.retagged).toEqual([downloaded]);
    expect(receipts(turn)).toEqual([
      {
        action: 'renameTrack',
        track: { id: downloaded, name: 'Harbor Lights' },
        previousName: 'Night Drive',
      },
    ]);
    expect(turn.results[0]).toBe(
      `Done: renamed the Track "Night Drive" to "Harbor Lights" (id ${downloaded}).`,
    );
  });

  it('takes "this" from the Track on the deck, and asks when there is none', async () => {
    const asker = await createMember();
    const { sessionId, streamOnly } = await seedSession(asker, 'Rainy Window');

    const nothingOn = await act(asker, [{ name: 'renameTrack', input: { name: 'Harbor' } }], {
      source: { kind: 'session', id: sessionId },
      trackId: null,
      playing: false,
    });
    expect(nothingOn.results[0]).toMatch(/no track is playing.*ask the user which track/i);
    expect(receipts(nothingOn)).toEqual([]);

    const turn = await act(asker, [{ name: 'renameTrack', input: { name: 'Harbor Lights' } }], {
      source: { kind: 'session', id: sessionId },
      trackId: streamOnly,
      playing: true,
    });
    expect(await trackTitle(asker, streamOnly)).toBe('Harbor Lights');
    expect(receipts(turn)).toMatchObject([{ track: { id: streamOnly, name: 'Harbor Lights' } }]);
  });

  it('refuses a Track shared with the asker in the Lounge, another user’s and an unknown id alike', async () => {
    const asker = await createMember();
    const other = await createMember();
    const theirs = await seedSession(other, 'Private');
    const shared = await createPlaylist(testDb.db, { ownerUserId: other, name: 'Night Owls' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: other,
      playlistId: shared.id,
      trackIds: [theirs.downloaded],
    });
    await setPlaylistShared(testDb.db, {
      ownerUserId: other,
      playlistId: shared.id,
      audience: { kind: 'everyone' },
    });

    const turn = await act(
      asker,
      [theirs.downloaded, theirs.streamOnly, UNKNOWN_ID].map((trackId) => ({
        name: 'renameTrack',
        input: { trackId, name: 'Mine Now' },
      })),
    );

    expect(new Set(turn.results)).toEqual(new Set(['No Track with that id. Nothing was changed.']));
    expect(receipts(turn)).toEqual([]);
    expect(await trackTitle(other, theirs.downloaded)).toBe('Night Drive');
    expect(holder.retagged).toEqual([]);
  });

  it('refuses a title the app would not take, and says why', async () => {
    const asker = await createMember();
    const { downloaded } = await seedSession(asker, 'Rainy Window');

    const turn = await act(asker, [
      { name: 'renameTrack', input: { trackId: downloaded, name: '' } },
      { name: 'renameTrack', input: { trackId: downloaded, name: 'x'.repeat(81) } },
    ]);

    expect(turn.results).toEqual([
      'A Track title has 1 to 80 characters. Nothing was changed.',
      'A Track title has 1 to 80 characters. Nothing was changed.',
    ]);
    expect(await trackTitle(asker, downloaded)).toBe('Night Drive');
  });
});

describe.skipIf(skip)('names and pins in one message', () => {
  it('count toward the three Library actions one message may lead to', async () => {
    const asker = await createMember();
    const { sessionId, downloaded } = await seedSession(asker, 'Rainy Window');

    const turn = await act(asker, [
      { name: 'renameSession', input: { sessionId, name: 'Sunday Coffee' } },
      { name: 'pinSession', input: { sessionId } },
      { name: 'renameTrack', input: { trackId: downloaded, name: 'Harbor Lights' } },
      { name: 'createPlaylist', input: { name: 'Sunday' } },
    ]);

    expect(receipts(turn)).toHaveLength(3);
    expect(turn.results.filter((result) => /already done 3 things/i.test(result))).toHaveLength(1);
  });
});
