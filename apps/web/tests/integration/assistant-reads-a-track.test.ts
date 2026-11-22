// What the Assistant's model is handed when it reads one Track: the fields of
// the Track Data sheet and the lyrics as stored, for a Track the asker can
// hear. The route, the tool and the app's own reads run against a real
// database; a scripted model stands in for the text LLM, and what the tool
// returned is read off what that model was sent next.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPlaylistTracks,
  createPlaylist,
  listenerProfiles,
  setPlaylistShared,
  updateUsageLimits,
  user,
  userProfiles,
} from '@liedmotif/db';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createSession,
  createTrack,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
  type TrackFixture,
} from '@liedmotif/db/testing';
import type { AssistantPlayerState } from '@liedmotif/shared';
import { askWithToolCall, type ToolTurn } from '../helpers/assistant-tool-turn';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionUserId: null as string | null,
  llm: null as unknown,
  getMusicProvider: vi.fn(),
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
  getMusicProvider: (...args: unknown[]) => holder.getMusicProvider(...args),
  getTypicalTracksPerMusicRequest: () => 2,
}));

const { POST } = await import('@/app/api/assistant/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

/** Everything the server logged during a test, one string. */
let logged = '';

const LYRICS =
  '[Verse]\nSalt on the window, the harbour asleep\n[Chorus]\nHold the light, hold the light';

async function createProfiledUser(id: string, role: 'admin' | 'member'): Promise<string> {
  await testDb.db.insert(user).values({ id, name: id, email: `${id}@example.test` });
  await testDb.db.insert(userProfiles).values({ userId: id, role });
  return id;
}

/** One Track of `ownerUserId`, in a stopped Session "Harbour Nights" of theirs. */
async function seedTrack(
  ownerUserId: string,
  track: Partial<Omit<TrackFixture, 'ownerUserId' | 'generationRequestId' | 'providerJobId'>> = {},
): Promise<string> {
  const sessionId = await createSession(testDb.db, {
    ownerUserId,
    status: 'stopped',
    title: 'Harbour Nights',
    userPrompt: 'songs for a night walk by the sea',
  });
  const generationRequestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    activitySessionId: sessionId,
    stylePrompt: 'indie folk, warm acoustic guitar, 92 bpm',
    expandedPrompt: 'Warm indie folk for a slow walk along the harbour at night.',
    userPrompt: 'songs for a night walk by the sea',
    styleSnapshot: { stylePrompt: 'indie folk', language: 'English' },
  });
  const providerJobId = await createProviderJob(testDb.db, { generationRequestId });
  return createTrack(testDb.db, {
    ownerUserId,
    generationRequestId,
    providerJobId,
    title: 'Salt Window',
    durationSeconds: 194,
    vocalMode: 'vocal',
    lyrics: LYRICS,
    genreTags: ['indie folk', 'acoustic'],
    activity: 'walking',
    mood: 'wistful',
    energy: 'low',
    bpmEstimate: 91.6,
    providerModel: 'V4_5',
    rightsNote: 'Personal, non-commercial use.',
    createdAt: new Date('2026-03-01T23:30:00Z'),
    audioStorageKey: `audio/${Math.random().toString(36).slice(2)}.mp3`,
    ...track,
  });
}

/** `userId` asks, the model calls the Track tool once with `input` and then answers. */
function askForTrack(
  userId: string,
  input: Record<string, unknown>,
  player?: AssistantPlayerState,
): Promise<ToolTurn> {
  holder.sessionUserId = userId;
  return askWithToolCall(
    POST,
    (llm) => {
      holder.llm = llm;
    },
    { name: 'readTrack', input },
    player,
  );
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('assistant-reads-a-track-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, [
    'playlist_tracks',
    'playlists',
    ...GENERATION_FIXTURE_TABLES,
    'listener_profiles',
    'user_settings',
    'app_settings',
  ]);
  holder.sessionUserId = null;
  holder.getMusicProvider.mockReset();
  logged = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((line) => {
    logged += String(line);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(skip)('the Assistant reads a Track', () => {
  it("hands over the Track Data sheet's fields and the stored lyrics of an own Track", async () => {
    const asker = await createProfiledUser('member-1', 'member');
    await testDb.db.insert(listenerProfiles).values({ ownerUserId: asker, artistName: 'Tide' });
    await updateUsageLimits(testDb.db, { resetTimezone: 'Europe/Berlin' });
    const trackId = await seedTrack(asker);

    const { result } = await askForTrack(asker, { trackId });

    expect(result).toContain(`Track "Salt Window" (id ${trackId})`);
    for (const line of [
      'Title: Salt Window',
      'Session: Harbour Nights',
      'Artist: Tide',
      // 23:30 UTC on March 1 is already March 2 in the Instance timezone.
      'Generated: Mar 2, 2026',
      'Duration: 3:14',
      "User's prompt: songs for a night walk by the sea",
      'Style prompt: indie folk, warm acoustic guitar, 92 bpm',
      'Expanded prompt: Warm indie folk for a slow walk along the harbour at night.',
      'Genres: indie folk, acoustic',
      'Activity: walking',
      'Mood: wistful',
      'Energy: low',
      'Vocals: Vocal · English',
      'BPM: 92',
      'Provider: mock',
      'Model: V4_5',
      'License: Personal, non-commercial use.',
    ]) {
      expect(result).toContain(line);
    }
    expect(result).toContain(`Lyrics:\n${LYRICS}`);
    expect(holder.getMusicProvider).not.toHaveBeenCalled();
  });

  it('leaves out the fields a Track has no value for', async () => {
    const asker = await createProfiledUser('member-1', 'member');
    const trackId = await seedTrack(asker, {
      activity: null,
      mood: null,
      providerModel: null,
      rightsNote: null,
      bpmEstimate: null,
    });

    const { result } = await askForTrack(asker, { trackId });

    expect(result).toContain('Energy: low');
    for (const label of ['Activity:', 'Mood:', 'Model:', 'License:', 'BPM:']) {
      expect(result).not.toContain(label);
    }
  });

  it('reads the Track that is playing when no id is given', async () => {
    const asker = await createProfiledUser('member-1', 'member');
    const trackId = await seedTrack(asker);

    const { result } = await askForTrack(
      asker,
      {},
      { source: { kind: 'session', id: randomUUID() }, trackId, playing: true },
    );

    expect(result).toContain(`Track "Salt Window" (id ${trackId})`);
    expect(result).toContain('Style prompt: indie folk, warm acoustic guitar, 92 bpm');
  });

  it('says so when no id is given and nothing is playing', async () => {
    const asker = await createProfiledUser('member-1', 'member');
    await seedTrack(asker);

    const { result } = await askForTrack(asker, {});

    expect(result).toBe(
      'No Track is playing, so "this" names nothing. Ask the user which Track they mean.',
    );
  });

  it("reads another user's Track shared with the asker in the Lounge", async () => {
    const owner = await createProfiledUser('member-2', 'member');
    const asker = await createProfiledUser('member-1', 'member');
    const trackId = await seedTrack(owner);
    const playlist = await createPlaylist(testDb.db, { ownerUserId: owner, name: 'Shared Mix' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: owner,
      playlistId: playlist.id,
      trackIds: [trackId],
    });
    await setPlaylistShared(testDb.db, {
      ownerUserId: owner,
      playlistId: playlist.id,
      audience: { kind: 'everyone' },
    });

    const { result } = await askForTrack(asker, { trackId });

    // Attributed to its owner, as the Track Data sheet attributes it.
    expect(result).toContain('Artist: member-2');
    expect(result).toContain(`Lyrics:\n${LYRICS}`);
  });

  it('says a Track has no lyrics when none are stored, and asks no provider for them', async () => {
    const asker = await createProfiledUser('member-1', 'member');
    const vocal = await seedTrack(asker, { lyrics: null });
    const instrumental = await seedTrack(asker, { lyrics: null, vocalMode: 'instrumental' });

    const vocalTurn = await askForTrack(asker, { trackId: vocal });
    const instrumentalTurn = await askForTrack(asker, { trackId: instrumental });

    expect(vocalTurn.result).toContain('Lyrics: none stored for this Track.');
    expect(instrumentalTurn.result).toContain('Vocals: Instrumental');
    expect(instrumentalTurn.result).toContain('Lyrics: none, it is instrumental.');
    expect(holder.getMusicProvider).not.toHaveBeenCalled();
  });

  it("answers another user's private Track and a malformed id alike, as unknown", async () => {
    const owner = await createProfiledUser('member-2', 'member');
    const asker = await createProfiledUser('member-1', 'member');
    const theirs = await seedTrack(owner);

    const privateTurn = await askForTrack(asker, { trackId: theirs });
    const malformedTurn = await askForTrack(asker, { trackId: 'not-an-id' });

    expect(privateTurn.result).toBe('No Track with that id.');
    expect(malformedTurn.result).toBe(privateTurn.result);
  });

  it('keeps what it read out of the logs', async () => {
    const asker = await createProfiledUser('member-1', 'member');
    const trackId = await seedTrack(asker);

    const { result } = await askForTrack(asker, { trackId });

    expect(result).toContain('Salt Window');
    for (const told of [
      trackId,
      'Salt Window',
      'Harbour Nights',
      'songs for a night walk by the sea',
      'indie folk, warm acoustic guitar',
      'Salt on the window',
    ]) {
      expect(logged).not.toContain(told);
    }
  });
});
