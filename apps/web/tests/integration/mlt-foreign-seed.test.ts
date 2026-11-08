import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from 'graphile-worker';
import { moreLikeThisResponseSchema } from '@liedmotif/shared';
import {
  addPlaylistTracks,
  createPlaylist,
  setPlaylistShared,
  updateUsageLimits,
} from '@liedmotif/db';
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

// More Like This from a FOREIGN track: a Visitor may seed
// a new Session from a Lounge-audible track — the session is THEIRS (their
// identity, their budget), the seeded style is stripped of the sharer's personal
// ingredients, and the moment the seed stops being Lounge-audible the route
// answers the uniform 404. The sharer's data stays untouched throughout.

const holder = vi.hoisted(() => ({ db: null as unknown, viewerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.viewerUserId ? { user: { id: holder.viewerUserId } } : null),
  getAppSession: async () => (holder.viewerUserId ? { user: { id: holder.viewerUserId } } : null),
}));
// Hermetic providers: no text LLM (seeded naming composes deterministically,
// and no fresh lyric notes are minted) and the mock music provider.
vi.mock('@/lib/providers', async () => {
  const { mockMusicProvider } = await import('@liedmotif/providers');
  const music = mockMusicProvider();
  return {
    getLlmProvider: async () => null,
    getMusicProvider: () => music,
    getStorageProvider: () => ({ stat: async () => null }),
  };
});

const { POST: moreLikeThis } = await import('@/app/api/sessions/more-like-this/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

/** A sharer's track styled with their PERSONAL ingredients, filed into one
 *  In-Lounge playlist of theirs — the Lounge-audible seed under test. */
async function seedSharedVocalTrack() {
  const sharerId = await createUser(testDb.db);
  const sessionId = await createSession(testDb.db, {
    ownerUserId: sharerId,
    styleSnapshot: {
      stylePrompt: 'warm synthwave, night drive',
      genreTags: ['synthwave'],
      vocalMode: 'vocal',
      energy: 'high',
      voiceGender: 'female',
      bpm: 112,
      key: 'F minor',
      useOwnVoice: true,
      lyricContext: 'people: Mira, my sister; scene: rooftop at dusk',
      seedParameters: { baseSeed: 7, rerollSalt: 0 },
    },
  });
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId: sharerId,
    activitySessionId: sessionId,
  });
  const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  const trackId = await createTrack(testDb.db, {
    ownerUserId: sharerId,
    generationRequestId: requestId,
    providerJobId: jobId,
  });
  const playlist = await createPlaylist(testDb.db, { ownerUserId: sharerId, name: 'Shared shelf' });
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
  return { sharerId, trackId, playlistId: playlist.id };
}

function post(trackIds: string[]) {
  return moreLikeThis(
    new Request('http://localhost/api/sessions/more-like-this', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seedTrackIds: trackIds, clientId: 'mlt-foreign-seed-test' }),
    }),
  );
}

async function sessionRows(ownerUserId: string) {
  const { rows } = await testDb.pool.query<{
    id: string;
    snapshot: Record<string, unknown> | null;
  }>(
    `select id, session_style_snapshot as snapshot
       from activity_sessions where owner_user_id = $1`,
    [ownerUserId],
  );
  return rows;
}

/** Record `n` spent provider calls for the user inside the current window. */
async function seedSpentTasks(ownerUserId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const generationRequestId = await createGenerationRequest(testDb.db, { ownerUserId });
    await createProviderJob(testDb.db, { generationRequestId, submitState: 'submitted' });
  }
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('mlt-foreign-seed-test');
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
});
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(skip)('POST /api/sessions/more-like-this — foreign seed', () => {
  // The switch on, so the foreign-seed strip — not the switch — is what clears
  // the sharer's own-voice opt-in.
  beforeEach(() => vi.stubEnv('OWN_VOICE_ENABLED', 'true'));

  it('creates the VISITOR’s session from a Lounge-audible seed, stripped of the sharer’s personal ingredients', async () => {
    const { sharerId, trackId } = await seedSharedVocalTrack();
    const sharerSessionsBefore = (await sessionRows(sharerId)).length;

    const response = await post([trackId]);
    expect(response.status).toBe(200);
    const parsed = moreLikeThisResponseSchema.parse(await response.json());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');

    // The new session is the visitor's, not the sharer's.
    const visitorSessions = await sessionRows(holder.viewerUserId!);
    expect(visitorSessions.map((row) => row.id)).toContain(parsed.data.session.id);
    expect((await sessionRows(sharerId)).length).toBe(sharerSessionsBefore);

    // Musical identity carried; the sharer's Own Voice intent and personal
    // lyric notes (their People) stripped — a leak here would make the worker
    // sing the sharer's notes with the visitor's voice profile.
    const stored = visitorSessions.find((row) => row.id === parsed.data.session.id)!.snapshot!;
    expect(stored.stylePrompt).toBe('warm synthwave, night drive');
    expect(stored.bpm).toBe(112);
    expect(stored.key).toBe('F minor');
    expect(stored.vocalMode).toBe('vocal');
    expect(stored.voiceGender).toBe('female');
    expect(stored.useOwnVoice).toBe(false);
    expect(stored.lyricContext).toBe('');
  });

  it('answers the uniform not-found once the seed is no longer Lounge-audible', async () => {
    const { sharerId, trackId, playlistId } = await seedSharedVocalTrack();
    await setPlaylistShared(testDb.db, {
      ownerUserId: sharerId,
      playlistId,
      audience: null,
    });

    const response = await post([trackId]);
    expect(response.status).toBe(404);
    const parsed = moreLikeThisResponseSchema.parse(await response.json());
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.error.code).toBe('not_found');
    expect(await sessionRows(holder.viewerUserId!)).toEqual([]);
  });

  it('admits by the VISITOR’s budget: an exhausted visitor is refused although the sharer has headroom', async () => {
    const { trackId } = await seedSharedVocalTrack();
    await updateUsageLimits(testDb.db, {
      dailyGenerationTasks: 2,
      monthlyGenerationTasks: 400,
      minHeadroomTracksToStartSession: 2,
      resetTimezone: 'UTC',
    });
    // The VISITOR spent the window; the sharer spent nothing — a route charging
    // the sharer's budget would pass this gate.
    await seedSpentTasks(holder.viewerUserId!, 2);

    const response = await post([trackId]);
    expect(response.status).toBe(429);
    const parsed = moreLikeThisResponseSchema.parse(await response.json());
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.error.code).toBe('session_headroom_blocked');
    expect(await sessionRows(holder.viewerUserId!)).toEqual([]);
  });
});

describe.skipIf(skip)('POST /api/sessions/more-like-this — own-voice seed, feature off', () => {
  beforeEach(() => vi.stubEnv('OWN_VOICE_ENABLED', ''));

  it('starts a generic-vocal session from the viewer’s own Own Voice track', async () => {
    const ownerUserId = holder.viewerUserId!;
    const sessionId = await createSession(testDb.db, {
      ownerUserId,
      styleSnapshot: {
        stylePrompt: 'warm synthwave, night drive',
        genreTags: ['synthwave'],
        vocalMode: 'vocal',
        energy: 'high',
        voiceGender: '',
        useOwnVoice: true,
        seedParameters: { baseSeed: 7, rerollSalt: 0 },
      },
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

    const response = await post([trackId]);
    expect(response.status).toBe(200);
    const parsed = moreLikeThisResponseSchema.parse(await response.json());
    if (!parsed.ok) throw new Error('unreachable');
    const stored = (await sessionRows(ownerUserId)).find(
      (row) => row.id === parsed.data.session.id,
    )!.snapshot!;
    expect(stored.vocalMode).toBe('vocal');
    expect(stored.useOwnVoice).toBe(false);
  });
});
