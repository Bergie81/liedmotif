import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from 'graphile-worker';
import { moreLikeThisResponseSchema, MAX_USER_PROMPT_LENGTH } from '@liedmotif/shared';
import {
  addPlaylistTracks,
  createPlaylist,
  setPlaylistShared,
  updateUsageLimits,
} from '@liedmotif/db';
import { ProviderError } from '@liedmotif/providers';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createSession,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// More Like This with a context ("for cooking"): the new Session's music is
// the seed's exactly, and everything written around it — Name, track titles,
// cover concept, activity, a vocal seed's lyric notes — is the seeded naming
// call's answer to the context. The context is the Session's prompt history.
// With a context the naming call is required: a refusal starts nothing.

/** The part of the naming call's input these tests read. */
type NamingInput = {
  context?: string | null;
  snapshot: { lyricContext: string };
  avoidTitles?: string[];
};

type NamingAnswer = {
  title: string;
  trackTitles: string[];
  lyricContext: string;
  coverConcept: string;
  autoCoverStyle: 'photographic' | null;
  activity?: string;
};

const holder = vi.hoisted(() => ({
  db: null as unknown,
  viewerUserId: null as string | null,
  /** Whether a text LLM is configured. */
  llmConfigured: true,
  /** Every input the naming call was handed, oldest first. */
  namingCalls: [] as unknown[],
  /** The scripted naming answer; a function may throw to fail the call. */
  naming: null as null | ((input: unknown) => unknown),
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.viewerUserId ? { user: { id: holder.viewerUserId } } : null),
  getAppSession: async () => (holder.viewerUserId ? { user: { id: holder.viewerUserId } } : null),
}));
// Hermetic providers: the mock music provider, and the mock text LLM with a
// scripted naming call that records what reached it. No network, no spend.
vi.mock('@/lib/providers/providers', async () => {
  const { mockLlmProvider, mockMusicProvider } = await import('@liedmotif/providers');
  const music = mockMusicProvider();
  const llm = mockLlmProvider();
  const scripted: typeof llm = {
    ...llm,
    async createSessionMetadata(input) {
      holder.namingCalls.push(input);
      return holder.naming
        ? (holder.naming(input) as Awaited<ReturnType<typeof llm.createSessionMetadata>>)
        : llm.createSessionMetadata(input);
    },
  };
  return {
    getLlmProvider: async () => (holder.llmConfigured ? scripted : null),
    getMusicProvider: () => music,
    getStorageProvider: () => ({ stat: async () => null }),
  };
});

const { POST: moreLikeThis } = await import('@/app/api/sessions/more-like-this/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

const SEED_NOTES = 'theme: night drive; people: Mira, my sister';
const VOCAL_SEED = {
  stylePrompt: 'warm synthwave, night drive',
  negativeTerms: ['country'],
  genreTags: ['synthwave'],
  mood: 'wistful',
  activity: 'running',
  vocalMode: 'vocal' as const,
  energy: 'high' as const,
  voiceGender: 'female',
  language: 'English',
  bpm: 112,
  key: 'F minor',
  styleStrength: 0.7,
  novelty: 0.3,
  avoid: 'country twang',
  useOwnVoice: false,
  title: 'Night Drive',
  trackTitles: ['Neon Exit', 'Tail Lights'],
  lyricContext: SEED_NOTES,
  seedParameters: { baseSeed: 7, rerollSalt: 0 },
};
const MUSIC_FIELDS = [
  'stylePrompt',
  'negativeTerms',
  'genreTags',
  'mood',
  'energy',
  'bpm',
  'key',
  'seedParameters',
  'styleStrength',
  'novelty',
  'avoid',
  'vocalMode',
  'voiceGender',
  'language',
  'useOwnVoice',
] as const;

const COOKING: NamingAnswer = {
  title: 'Kitchen Lights',
  trackTitles: ['Simmer', 'Zest', 'Garlic Moon'],
  lyricContext: 'theme: cooking dinner; people: Mira, my sister',
  coverConcept: 'A steaming pot under a warm kitchen lamp.',
  autoCoverStyle: 'photographic',
  activity: 'cooking',
};

/** A track of the viewer's own, made by a Session with `snapshot`; that Session is active. */
async function seedOwnTrack(snapshot: Record<string, unknown> = VOCAL_SEED) {
  const ownerUserId = holder.viewerUserId!;
  const sessionId = await createSession(testDb.db, {
    ownerUserId,
    styleSnapshot: snapshot,
    title: 'Night Drive',
  });
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  const trackId = await createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId: jobId,
  });
  return { sessionId, trackId };
}

function post(body: Record<string, unknown>) {
  return moreLikeThis(
    new Request('http://localhost/api/sessions/more-like-this', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'mlt-context-test', ...body }),
    }),
  );
}

async function createdSession(response: Response) {
  expect(response.status).toBe(200);
  const parsed = moreLikeThisResponseSchema.parse(await response.json());
  if (!parsed.ok) throw new Error(`expected a session, got ${parsed.error.code}`);
  const { rows } = await testDb.pool.query<{
    title: string;
    user_prompt: string | null;
    cover_concept: string | null;
    auto_cover_style: string | null;
    snapshot: Record<string, unknown>;
  }>(
    `select title, user_prompt, cover_concept, auto_cover_style,
            session_style_snapshot as snapshot
       from activity_sessions where id = $1`,
    [parsed.data.session.id],
  );
  return rows[0]!;
}

async function refusal(response: Response) {
  const parsed = moreLikeThisResponseSchema.parse(await response.json());
  if (parsed.ok) throw new Error('expected a refusal');
  return { status: response.status, ...parsed.error };
}

/** What a refused request must leave behind: no new row, nothing queued, the active Session active. */
async function expectNothingStarted(activeSessionId: string) {
  const sessions = await testDb.pool.query<{ id: string; status: string }>(
    'select id, status from activity_sessions where owner_user_id = $1',
    [holder.viewerUserId],
  );
  expect(sessions.rows).toEqual([{ id: activeSessionId, status: 'active' }]);
  const jobs = await testDb.pool.query('select 1 from graphile_worker._private_jobs');
  expect(jobs.rowCount).toBe(0);
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('more-like-this-with-a-context-test');
  holder.db = testDb.db;
  await runMigrations({ connectionString: TEST_DATABASE_URL });
}, 60_000);
afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});
beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, [...GENERATION_FIXTURE_TABLES, 'app_settings']);
  await testDb.pool.query('delete from graphile_worker._private_jobs');
  holder.viewerUserId = await createUser(testDb.db);
  holder.llmConfigured = true;
  holder.namingCalls = [];
  holder.naming = () => COOKING;
});

describe.skipIf(skip)('POST /api/sessions/more-like-this — with a context', () => {
  it('keeps the seed’s music and stores the naming call’s answer to the context', async () => {
    const { trackId } = await seedOwnTrack();

    const stored = await createdSession(
      await post({ seedTrackIds: [trackId], context: ' for cooking ' }),
    );

    for (const field of MUSIC_FIELDS) expect(stored.snapshot[field]).toEqual(VOCAL_SEED[field]);
    expect(stored.title).toBe('Kitchen Lights');
    expect(stored.snapshot.trackTitles).toEqual(COOKING.trackTitles);
    expect(stored.snapshot.lyricContext).toBe(COOKING.lyricContext);
    expect(stored.snapshot.activity).toBe('cooking');
    expect(stored.cover_concept).toBe(COOKING.coverConcept);
    expect(stored.auto_cover_style).toBe('photographic');
    expect(stored.user_prompt).toBe('for cooking');
  });

  it('hands the call the context, the seed’s lyric notes and the seed’s names as taken', async () => {
    const { trackId } = await seedOwnTrack();

    await createdSession(await post({ seedTrackIds: [trackId], context: 'for cooking' }));

    expect(holder.namingCalls).toHaveLength(1);
    const input = holder.namingCalls[0] as NamingInput;
    expect(input.context).toBe('for cooking');
    expect(input.snapshot.lyricContext).toBe(SEED_NOTES);
    expect(input.avoidTitles).toEqual(['Night Drive', 'Neon Exit', 'Tail Lights']);
  });

  it('stores lyric notes for a vocal seed when the listener has no profile', async () => {
    await testDb.pool.query(`update "user" set name = '' where id = $1`, [holder.viewerUserId]);
    const { trackId } = await seedOwnTrack();

    const stored = await createdSession(
      await post({ seedTrackIds: [trackId], context: 'for cooking' }),
    );

    expect(stored.snapshot.lyricContext).toBe(COOKING.lyricContext);
  });

  it('stores no lyric notes for an instrumental seed', async () => {
    const { trackId } = await seedOwnTrack({
      ...VOCAL_SEED,
      vocalMode: 'instrumental',
      lyricContext: '',
    });

    const stored = await createdSession(
      await post({ seedTrackIds: [trackId], context: 'for cooking' }),
    );

    expect(stored.snapshot.lyricContext).toBe('');
    expect(stored.title).toBe('Kitchen Lights');
  });

  it('clears the seed’s activity when the answer has none', async () => {
    const { trackId } = await seedOwnTrack();
    holder.naming = () => ({ ...COOKING, activity: undefined });

    const stored = await createdSession(
      await post({ seedTrackIds: [trackId], context: 'for cooking' }),
    );

    expect(stored.snapshot.activity).toBe('');
  });

  it('never hands the call a foreign seed’s lyric notes', async () => {
    const sharerId = await createUser(testDb.db);
    const sharerSession = await createSession(testDb.db, {
      ownerUserId: sharerId,
      styleSnapshot: VOCAL_SEED,
    });
    const requestId = await createGenerationRequest(testDb.db, {
      ownerUserId: sharerId,
      activitySessionId: sharerSession,
    });
    const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
    const trackId = await createTrack(testDb.db, {
      ownerUserId: sharerId,
      generationRequestId: requestId,
      providerJobId: jobId,
    });
    const playlist = await createPlaylist(testDb.db, { ownerUserId: sharerId, name: 'Shelf' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: sharerId,
      playlistId: playlist.id,
      trackIds: [trackId],
    });
    await setPlaylistShared(testDb.db, {
      ownerUserId: sharerId,
      playlistId: playlist.id,
      audience: { kind: 'everyone' },
    });

    await createdSession(await post({ seedTrackIds: [trackId], context: 'for cooking' }));

    expect(holder.namingCalls).toHaveLength(1);
    expect(JSON.stringify(holder.namingCalls[0])).not.toContain('Mira');
  });

  it('reads a blank context as none', async () => {
    const { trackId } = await seedOwnTrack();
    holder.naming = () => ({ ...COOKING, activity: 'ignored' });

    const stored = await createdSession(await post({ seedTrackIds: [trackId], context: '   ' }));

    expect(stored.user_prompt).toBeNull();
    expect(stored.snapshot.activity).toBe('running');
    expect((holder.namingCalls[0] as NamingInput).context ?? null).toBeNull();
  });

  it('refuses a context over the prompt limit', async () => {
    const { trackId } = await seedOwnTrack();

    const response = await post({
      seedTrackIds: [trackId],
      context: 'x'.repeat(MAX_USER_PROMPT_LENGTH + 1),
    });

    expect(response.status).toBe(400);
    expect(holder.namingCalls).toHaveLength(0);
  });
});

describe.skipIf(skip)('POST /api/sessions/more-like-this — a context refused', () => {
  it('refuses a context without a text AI, starting nothing', async () => {
    const { sessionId, trackId } = await seedOwnTrack();
    holder.llmConfigured = false;

    const error = await refusal(await post({ seedTrackIds: [trackId], context: 'for cooking' }));

    expect(error.code).toBe('validation_error');
    await expectNothingStarted(sessionId);
  });

  it.each([
    [
      'fails',
      () => {
        throw new ProviderError('The text AI took too long to respond. Try again.');
      },
    ],
    ['answers no Name', () => ({ ...COOKING, title: '' })],
    ['answers no title pool', () => ({ ...COOKING, trackTitles: [] })],
  ])(
    'answers a retryable error when the naming call %s, starting nothing',
    async (_case, answer) => {
      const { sessionId, trackId } = await seedOwnTrack();
      holder.naming = answer;

      const error = await refusal(await post({ seedTrackIds: [trackId], context: 'for cooking' }));

      expect(error.code).toBe('provider_error');
      expect(error.retryable).toBe(true);
      await expectNothingStarted(sessionId);
    },
  );

  it('answers a retryable error for a seed whose style cannot be read, starting nothing', async () => {
    const { sessionId, trackId } = await seedOwnTrack({ ...VOCAL_SEED, stylePrompt: '' });

    const error = await refusal(await post({ seedTrackIds: [trackId], context: 'for cooking' }));

    expect(error.code).toBe('provider_error');
    expect(holder.namingCalls).toHaveLength(0);
    await expectNothingStarted(sessionId);
  });

  it('answers the headroom refusal before the naming call', async () => {
    const { trackId } = await seedOwnTrack();
    await updateUsageLimits(testDb.db, {
      dailyGenerationTasks: 2,
      monthlyGenerationTasks: 400,
      minHeadroomTracksToStartSession: 2,
      resetTimezone: 'UTC',
    });
    for (let i = 0; i < 2; i += 1) {
      const generationRequestId = await createGenerationRequest(testDb.db, {
        ownerUserId: holder.viewerUserId!,
      });
      await createProviderJob(testDb.db, { generationRequestId, submitState: 'submitted' });
    }

    const error = await refusal(await post({ seedTrackIds: [trackId], context: 'for cooking' }));

    expect(error.code).toBe('session_headroom_blocked');
    expect(holder.namingCalls).toHaveLength(0);
  });

  it('answers an unreadable seed before the naming call', async () => {
    await seedOwnTrack();

    const error = await refusal(
      await post({
        seedTrackIds: ['00000000-0000-4000-8000-000000000000'],
        context: 'for cooking',
      }),
    );

    expect(error.code).toBe('not_found');
    expect(holder.namingCalls).toHaveLength(0);
  });
});

describe.skipIf(skip)('POST /api/sessions/more-like-this — without a context', () => {
  it('stores the seed’s activity and notes with no prompt history', async () => {
    const { trackId } = await seedOwnTrack();
    holder.naming = () => ({ ...COOKING, lyricContext: 'fresh notes', activity: 'ignored' });

    const stored = await createdSession(await post({ seedTrackIds: [trackId] }));

    expect(stored.user_prompt).toBeNull();
    expect(stored.title).toBe('Kitchen Lights');
    expect(stored.snapshot.activity).toBe('running');
    expect(stored.snapshot.lyricContext).toBe(SEED_NOTES);
    for (const field of MUSIC_FIELDS) expect(stored.snapshot[field]).toEqual(VOCAL_SEED[field]);
  });

  it('still creates the Session when the best-effort naming call fails', async () => {
    const { trackId } = await seedOwnTrack();
    holder.naming = () => {
      throw new ProviderError('naming failed');
    };

    const stored = await createdSession(await post({ seedTrackIds: [trackId] }));

    expect(stored.title.length).toBeGreaterThan(0);
    expect(stored.title).not.toBe('Night Drive');
    expect(stored.snapshot.lyricContext).toBe(SEED_NOTES);
  });
});
