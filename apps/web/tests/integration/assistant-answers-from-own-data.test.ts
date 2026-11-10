// What the Assistant's model is handed when it looks up the asking user's own
// data: what is playing, and what is left of the budget. The route, the tools
// and the app's own domain functions run against a real database; a scripted
// model stands in for the text LLM, and what each tool returned is read off
// what that model was sent next.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPlaylistTracks,
  createPlaylist,
  setPlaylistShared,
  updateMemberLimits,
  updateUsageLimits,
  user,
  userProfiles,
} from '@liedmotif/db';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createSession,
  GENERATION_FIXTURE_TABLES,
  seedSessionTrack,
  TEST_DATABASE_URL,
  truncateTables,
  type SessionFixture,
  type TestDb,
} from '@liedmotif/db/testing';
import { createOpenRouterLlmProvider } from '@liedmotif/providers';
import { scriptedLanguageModel } from '@liedmotif/providers/testing';
import type { AssistantPlayerState } from '@liedmotif/shared';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionUserId: null as string | null,
  llm: null as unknown,
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth', () => ({
  getAuth: () => ({
    api: {
      getSession: async () =>
        holder.sessionUserId
          ? { session: { id: 'live' }, user: { id: holder.sessionUserId } }
          : null,
    },
  }),
}));
vi.mock('@/lib/providers', () => ({
  getLlmProvider: async () => holder.llm,
  // The music provider's two Tracks per call: budgets are counted in calls
  // and told in Tracks.
  getTypicalTracksPerMusicRequest: () => 2,
}));

const { POST } = await import('@/app/api/assistant/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

/** Everything the server logged during a test, one string. */
let logged = '';

async function createProfiledUser(id: string, role: 'admin' | 'member'): Promise<string> {
  await testDb.db.insert(user).values({ id, name: id, email: `${id}@example.test` });
  await testDb.db.insert(userProfiles).values({ userId: id, role });
  return id;
}

/** A Session of `ownerUserId` with one playable Track. */
async function seedSession(
  ownerUserId: string,
  session: Omit<SessionFixture, 'ownerUserId'>,
  trackTitle: string,
): Promise<{ sessionId: string; trackId: string }> {
  const sessionId = await createSession(testDb.db, { ownerUserId, ...session });
  const trackId = await seedSessionTrack(testDb.db, ownerUserId, sessionId, { title: trackTitle });
  return { sessionId, trackId };
}

/** A Playlist of `ownerUserId` holding one Track of a stopped Session of theirs. */
async function seedPlaylist(
  ownerUserId: string,
  name: string,
  trackTitle: string,
): Promise<{ playlistId: string; trackId: string }> {
  const { trackId } = await seedSession(ownerUserId, { status: 'stopped' }, trackTitle);
  const playlist = await createPlaylist(testDb.db, { ownerUserId, name });
  await addPlaylistTracks(testDb.db, { ownerUserId, playlistId: playlist.id, trackIds: [trackId] });
  return { playlistId: playlist.id, trackId };
}

/** `count` music-model calls `ownerUserId` has spent today. */
async function spendCalls(ownerUserId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const generationRequestId = await createGenerationRequest(testDb.db, { ownerUserId });
    await createProviderJob(testDb.db, { generationRequestId });
  }
}

/**
 * `userId` asks, the model calls `tool` once and then answers. Returns what the
 * tool handed the model, and the system prompt the turn opened with.
 */
async function askWithTool(
  userId: string,
  tool: 'nowPlaying' | 'budget',
  player?: AssistantPlayerState,
): Promise<{ result: string; system: string }> {
  const model = scriptedLanguageModel([
    { toolCalls: [{ name: tool, input: {} }] },
    { text: ['Here you go.'] },
  ]);
  holder.llm = createOpenRouterLlmProvider({
    apiKey: 'sk-or-test-key',
    model: 'test-model',
    languageModel: model,
  });
  holder.sessionUserId = userId;

  const response = await POST(
    new Request('http://localhost/api/assistant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Look it up.' }], player }),
    }),
  );
  expect(response.status).toBe(200);
  await response.text();

  expect(model.doStreamCalls).toHaveLength(2);
  const [first, second] = model.doStreamCalls.map((call) => call.prompt);
  const results = second!.flatMap((message) =>
    message.role === 'tool'
      ? message.content.flatMap((part) => (part.type === 'tool-result' ? [part.output] : []))
      : [],
  );
  expect(results).toHaveLength(1);
  const [output] = results;
  expect(output).toMatchObject({ type: 'text' });
  return {
    result: output?.type === 'text' ? output.value : '',
    system: String(first![0]?.content),
  };
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('assistant-own-data-test');
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
    'user_settings',
    'app_settings',
  ]);
  holder.sessionUserId = null;
  logged = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((line) => {
    logged += String(line);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(skip)('the Assistant asked what is playing', () => {
  it('answers a playing Playlist from the player state', async () => {
    const asker = await createProfiledUser('member-1', 'member');
    const { playlistId, trackId } = await seedPlaylist(asker, 'Running', 'Night Drive');

    const { result } = await askWithTool(asker, 'nowPlaying', {
      source: { kind: 'playlist', id: playlistId },
      trackId,
      playing: true,
    });

    expect(result).toContain('Playlist: "Running"');
    expect(result).toContain(playlistId);
    expect(result).toContain('Track: "Night Drive"');
    expect(result).toContain(trackId);
    expect(result).toContain('Player: playing');
    // A Playlist never generates, so it has no New music mode to report.
    expect(result).not.toContain('New music');
  });

  it('keeps the player state and what was looked up out of the system prompt and the logs', async () => {
    const asker = await createProfiledUser('member-1', 'member');
    const { playlistId, trackId } = await seedPlaylist(asker, 'Quartz Lantern', 'Velvet Antenna');

    const withPlayer = await askWithTool(asker, 'nowPlaying', {
      source: { kind: 'playlist', id: playlistId },
      trackId,
      playing: true,
    });
    const withoutPlayer = await askWithTool(asker, 'nowPlaying');

    expect(withPlayer.result).toContain('Velvet Antenna');
    expect(withPlayer.system).toBe(withoutPlayer.system);
    for (const told of ['Quartz Lantern', 'Velvet Antenna', playlistId, trackId]) {
      expect(withPlayer.system).not.toContain(told);
      expect(logged).not.toContain(told);
    }
  });

  it('answers an engaged Session with its New music mode and duration target', async () => {
    const asker = await createProfiledUser('member-1', 'member');
    const { sessionId, trackId } = await seedSession(
      asker,
      { title: 'Deep Focus', sessionMode: 'keep_going', targetDurationMinutes: 60 },
      'First Light',
    );

    const { result } = await askWithTool(asker, 'nowPlaying', {
      source: { kind: 'session', id: sessionId },
      trackId,
      playing: false,
    });

    expect(result).toContain('Session: "Deep Focus"');
    expect(result).toContain(sessionId);
    expect(result).toContain('Track: "First Light"');
    expect(result).toContain('Player: paused');
    expect(result).toContain('New music: on, duration target 60 min');
  });

  it('says New music is off for a Session in Repeat', async () => {
    const asker = await createProfiledUser('member-1', 'member');
    const { sessionId, trackId } = await seedSession(
      asker,
      { title: 'Deep Focus', sessionMode: 'repeat' },
      'First Light',
    );

    const { result } = await askWithTool(asker, 'nowPlaying', {
      source: { kind: 'session', id: sessionId },
      trackId,
      playing: true,
    });

    expect(result).toContain('New music: off');
  });

  it('says that an engaged Session which is stopped generates nothing', async () => {
    const asker = await createProfiledUser('member-1', 'member');
    const { sessionId, trackId } = await seedSession(
      asker,
      { title: 'Deep Focus', status: 'stopped' },
      'First Light',
    );

    const { result } = await askWithTool(asker, 'nowPlaying', {
      source: { kind: 'session', id: sessionId },
      trackId,
      playing: true,
    });

    expect(result).toContain('Session: "Deep Focus"');
    expect(result).toMatch(/stopped: nothing is generated until it is resumed/);
  });

  it("answers another user's Playlist the asker can see in the Lounge", async () => {
    const owner = await createProfiledUser('member-2', 'member');
    const asker = await createProfiledUser('member-1', 'member');
    const { playlistId, trackId } = await seedPlaylist(owner, 'Shared Mix', 'Open Road');
    await setPlaylistShared(testDb.db, {
      ownerUserId: owner,
      playlistId,
      audience: { kind: 'everyone' },
    });

    const { result } = await askWithTool(asker, 'nowPlaying', {
      source: { kind: 'playlist', id: playlistId },
      trackId,
      playing: true,
    });

    expect(result).toContain('Playlist: "Shared Mix"');
    expect(result).toContain('Track: "Open Road"');
  });

  it('ignores a player state that names what the asker cannot see', async () => {
    const owner = await createProfiledUser('member-2', 'member');
    const asker = await createProfiledUser('member-1', 'member');
    const theirPlaylist = await seedPlaylist(owner, 'Private Mix', 'Hidden Song');
    const theirSession = await seedSession(owner, { title: 'Private Session' }, 'Hidden Take');

    for (const player of [
      {
        source: { kind: 'playlist', id: theirPlaylist.playlistId },
        trackId: theirPlaylist.trackId,
      },
      { source: { kind: 'session', id: theirSession.sessionId }, trackId: theirSession.trackId },
    ] as const) {
      const { result } = await askWithTool(asker, 'nowPlaying', { ...player, playing: true });

      expect(result).toBe('Nothing is playing, and there is no active Session.');
    }
  });

  it('leaves out a Track the asker cannot see, inside a source they can', async () => {
    const owner = await createProfiledUser('member-2', 'member');
    const asker = await createProfiledUser('member-1', 'member');
    const mine = await seedPlaylist(asker, 'Running', 'Night Drive');
    const theirs = await seedPlaylist(owner, 'Private Mix', 'Hidden Song');

    const { result } = await askWithTool(asker, 'nowPlaying', {
      source: { kind: 'playlist', id: mine.playlistId },
      trackId: theirs.trackId,
      playing: true,
    });

    expect(result).toContain('Playlist: "Running"');
    expect(result).not.toContain('Hidden Song');
    expect(result).not.toContain(theirs.trackId);
  });

  it("falls back to the server's active Session when the browser has nothing engaged", async () => {
    const asker = await createProfiledUser('member-1', 'member');
    const { sessionId } = await seedSession(asker, { title: 'Deep Focus' }, 'First Light');

    const { result } = await askWithTool(asker, 'nowPlaying');

    expect(result).toContain('Nothing is playing in this browser.');
    expect(result).toContain('Session: "Deep Focus"');
    expect(result).toContain(sessionId);
    expect(result).toContain('New music: on, no duration target');
    expect(result).not.toContain('Player:');
  });

  it('says so when nothing is playing', async () => {
    const asker = await createProfiledUser('member-1', 'member');
    // Somebody else's active Session is not the asker's.
    await seedSession(await createProfiledUser('member-2', 'member'), { title: 'Theirs' }, 'Take');

    const { result } = await askWithTool(asker, 'nowPlaying');

    expect(result).toBe('Nothing is playing, and there is no active Session.');
  });
});

// Default budgets, in Tracks at two per call: a Member has 20 a day and 100 a
// month, the Members' shared budget 50 and 250, the Admin's instance 50 and 250.
describe.skipIf(skip)('the Assistant asked what is left of the budget', () => {
  it("gives a Member their own budget and the shared one, never another Member's", async () => {
    const asker = await createProfiledUser('member-1', 'member');
    const other = await createProfiledUser('member-2', 'member');
    await updateMemberLimits(testDb.db, {
      ownerUserId: other,
      patch: { dailyGenerationTasks: 4, monthlyGenerationTasks: 9 },
    });
    await spendCalls(asker, 2);
    await spendCalls(other, 3);

    const { result } = await askWithTool(asker, 'budget');

    expect(result).toContain(
      'Your budget: 16 of 20 Tracks left today, 96 of 100 Tracks left this month.',
    );
    // Everything both Members spent counts against the shared budget.
    expect(result).toContain(
      'Shared budget of all Members: 40 of 50 Tracks left today, 240 of 250 Tracks left this month.',
    );
    // The other Member's own bound: 8 a day, 18 a month, 2 and 12 of them left.
    expect(result).not.toMatch(/of (8|18) Tracks/);
    expect(result).not.toMatch(/\b(2|12) of/);
  });

  it('gives a Member on a one-time budget what is left of it', async () => {
    const asker = await createProfiledUser('member-1', 'member');
    await updateMemberLimits(testDb.db, {
      ownerUserId: asker,
      patch: {
        kind: 'oneTime',
        totalGenerationTasks: 6,
        grantedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    await spendCalls(asker, 1);

    const { result } = await askWithTool(asker, 'budget');

    expect(result).toContain('Your budget: 10 of 12 Tracks left.');
    expect(result).toMatch(/does not refill/);
  });

  it('gives the Admin the instance limits, which no Member spends from', async () => {
    const admin = await createProfiledUser('admin-1', 'admin');
    await spendCalls(admin, 3);
    await spendCalls(await createProfiledUser('member-1', 'member'), 4);

    const { result } = await askWithTool(admin, 'budget');

    expect(result).toBe(
      'Instance limit: 44 of 50 Tracks left today, 244 of 250 Tracks left this month.',
    );
  });

  it('tells the Admin when no limit is set', async () => {
    const admin = await createProfiledUser('admin-1', 'admin');
    await updateUsageLimits(testDb.db, { trackCeilingEnabled: false });
    await spendCalls(admin, 3);

    const { result } = await askWithTool(admin, 'budget');

    expect(result).toBe(
      'Instance limit: no limit set today (6 Tracks generated), no limit set this month (6 Tracks generated).',
    );
  });
});
