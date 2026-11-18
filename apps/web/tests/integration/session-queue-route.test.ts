import { eq } from 'drizzle-orm';
import { activitySessions, tracks, updateUsageLimits } from '@liedmotif/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_ANALYSIS_VERSION, getSessionQueueResponseSchema } from '@liedmotif/shared';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createQueueItem,
  createSession,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// The queue contract's blend extension: each item
// carries the generation-time identity (targetBpm/targetKey/styleRevision from its
// REQUEST), the pinned per-source asset paths, and the (stale-suppressed)
// `blendAnalysis` object. Every response is validated against the SHARED contract
// schema — the same decode the api-client performs — so route and client can't drift.

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));

// Deliberately NOT the mock provider's own figure (2): the in-flight counts
// must come from the configured provider's capability, not a constant.
const TRACKS_PER_REQUEST = 3;
vi.mock('@/lib/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/providers')>()),
  getTypicalTracksPerMusicRequest: () => TRACKS_PER_REQUEST,
}));

const { GET } = await import('@/app/api/sessions/queue/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

async function callQueue(sessionId: string) {
  const res = await GET(new Request(`http://localhost/api/sessions/queue?sessionId=${sessionId}`));
  const parsed = getSessionQueueResponseSchema.parse(await res.json());
  if (!parsed.ok) throw new Error('expected an ok queue response');
  return parsed.data;
}

interface SeedTrackOptions {
  identity?: { styleRevision: number; targetBpm: number; targetKey: string } | null;
  withFinal?: boolean;
  withStream?: boolean;
  analysis?: {
    analysisStatus: 'measured' | 'partial' | 'unavailable' | 'failed';
    analysisVersion: number;
    bpmSource?: 'measured' | 'anchored';
    bpmEstimate?: number;
    lufsIntegrated?: number;
  };
}

let seedCounter = 0;
async function seedQueuedTrack(
  base: { ownerUserId: string; sessionId: string },
  position: number,
  opts: SeedTrackOptions = {},
): Promise<string> {
  seedCounter += 1;
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId: base.ownerUserId,
    activitySessionId: base.sessionId,
    ...(opts.identity
      ? {
          styleRevision: opts.identity.styleRevision,
          targetBpm: opts.identity.targetBpm,
          targetKey: opts.identity.targetKey,
        }
      : {}),
  });
  const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  const trackId = await createTrack(testDb.db, {
    ownerUserId: base.ownerUserId,
    generationRequestId: requestId,
    providerJobId: jobId,
    status: 'ready',
    ...(opts.withFinal === false ? {} : { audioStorageKey: `audio/q-${seedCounter}.mp3` }),
    ...(opts.withStream ? { streamEncryptedSourceUrl: `enc:stream-${seedCounter}` } : {}),
    ...(opts.analysis
      ? {
          analysisStatus: opts.analysis.analysisStatus,
          analysisVersion: opts.analysis.analysisVersion,
          bpmSource: opts.analysis.bpmSource ?? 'measured',
          bpmEstimate: opts.analysis.bpmEstimate ?? 120,
          bpmConfidence: 0.9,
          lufsIntegrated: opts.analysis.lufsIntegrated ?? -13,
          truePeakDb: -1.5,
        }
      : {}),
  });
  await createQueueItem(testDb.db, { activitySessionId: base.sessionId, trackId, position });
  return trackId;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('session-queue-route-test');
  holder.db = testDb.db;
});
afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});
beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, GENERATION_FIXTURE_TABLES);
  // `app_settings` is shared across suites: an armed switch reads the pause.
  await updateUsageLimits(testDb.db, { manualGenerationOnly: false });
  holder.ownerUserId = null;
});

describe.skipIf(skip)('GET /api/sessions/queue — blend identity + analysis contract', () => {
  afterEach(() => vi.unstubAllEnvs());

  async function seedSession(): Promise<{ ownerUserId: string; sessionId: string }> {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId });
    return { ownerUserId, sessionId };
  }

  it('polls the live target and usable duration independently of the visible Queue window', async () => {
    const base = await seedSession();
    await testDb.db
      .update(activitySessions)
      .set({ targetDurationMinutes: 20 })
      .where(eq(activitySessions.id, base.sessionId));
    const known = await seedQueuedTrack(base, 0);
    await seedQueuedTrack(base, 1);
    await testDb.db.update(tracks).set({ durationSeconds: 720 }).where(eq(tracks.id, known));
    expect(await callQueue(base.sessionId)).toMatchObject({
      targetDurationMinutes: 20,
      generatedDurationSeconds: 720,
      unknownDurationTrackCount: 1,
    });
    await testDb.db.update(tracks).set({ status: 'deleted' }).where(eq(tracks.id, known));
    expect(await callQueue(base.sessionId)).toMatchObject({
      targetDurationMinutes: 20,
      generatedDurationSeconds: 0,
      unknownDurationTrackCount: 1,
    });
  });

  it('a downloaded, analyzed track carries identity, both pinned assets, and blendAnalysis', async () => {
    const base = await seedSession();
    const trackId = await seedQueuedTrack(base, 0, {
      identity: { styleRevision: 1, targetBpm: 124, targetKey: 'A minor' },
      withFinal: true,
      withStream: true,
      analysis: {
        analysisStatus: 'measured',
        analysisVersion: CURRENT_ANALYSIS_VERSION,
        bpmEstimate: 123.7,
      },
    });

    const data = await callQueue(base.sessionId);
    // The session-level LIVE revision rides along (the player clears a
    // loop pin when a Change Vibe moves it).
    expect(data.styleRevision).toBe(1);
    const item = data.items[0]!;
    expect(item.vibeSwitchSetAside).toBe(false);
    expect(item.targetBpm).toBe(124);
    expect(item.targetKey).toBe('A minor');
    expect(item.styleRevision).toBe(1);
    expect(item.assets).toEqual({
      final: `/api/audio/${trackId}?asset=final`,
      stream: `/api/audio/${trackId}?asset=stream`,
    });
    expect(item.blendAnalysis).toMatchObject({
      version: CURRENT_ANALYSIS_VERSION,
      status: 'complete',
      bpm: 123.7,
      bpmSource: 'measured',
    });
  });

  it('exposes switch-now set-aside provenance independently of queue state and revision', async () => {
    const base = await seedSession();
    const trackId = await seedQueuedTrack(base, 0, {
      identity: { styleRevision: 1, targetBpm: 124, targetKey: 'A minor' },
    });
    await testDb.pool.query(
      `update activity_session_queue_items
       set state = 'skipped', vibe_switch_set_aside = true
       where activity_session_id = $1 and track_id = $2`,
      [base.sessionId, trackId],
    );

    expect((await callQueue(base.sessionId)).items[0]).toMatchObject({
      state: 'skipped',
      vibeSwitchSetAside: true,
      styleRevision: 1,
    });
  });

  it('windows the read: last 30 slots before the current item + everything forward, `earlierTracks` counting the playable rest', async () => {
    const base = await seedSession();
    // 0–4 fall outside the window: three playable Tracks, two slots with none.
    for (const position of [0, 1, 2]) await seedQueuedTrack(base, position);
    for (let position = 3; position < 35; position += 1) {
      await createQueueItem(testDb.db, {
        activitySessionId: base.sessionId,
        position,
        state: 'played',
      });
    }
    const currentId = await createQueueItem(testDb.db, {
      activitySessionId: base.sessionId,
      position: 35,
      state: 'playing',
    });
    await testDb.pool.query(
      `update activity_sessions set current_queue_item_id = $1 where id = $2`,
      [currentId, base.sessionId],
    );
    // The playable track ahead must survive the window untouched.
    const aheadTrackId = await seedQueuedTrack(base, 36, { withFinal: true });

    const data = await callQueue(base.sessionId);
    // Positions 0–4 elided, three of them playable; 5–36 returned in order.
    expect(data.earlierTracks).toBe(3);
    expect(data.items.map((item) => item.position)).toEqual(
      Array.from({ length: 32 }, (_, index) => index + 5),
    );
    expect(data.currentQueueItemId).toBe(currentId);
    // The playable-track derivation is unchanged by the window: the ready
    // track ahead still resolves its pinned final asset.
    const ahead = data.items.find((item) => item.trackId === aheadTrackId)!;
    expect(ahead.assets.final).toBe(`/api/audio/${aheadTrackId}?asset=final`);
  });

  it('projects the current vibe facets (and the stored intent) for the Change Vibe overlay', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, {
      ownerUserId,
      userPrompt: 'dark warehouse techno',
      styleSnapshot: {
        stylePrompt: 'techno, deep house, high energy, with vocals',
        genreTags: ['techno', 'deep house'],
        energy: 'high',
        vocalMode: 'vocal',
        voiceGender: 'female',
        language: 'German',
        lyricContext: 'private listener notes',
        styleStrength: 0.9,
        novelty: 0.05,
        userAvoid: 'saxophone',
      },
    });

    const data = await callQueue(sessionId);
    // Exactly these facets — stylePrompt/lyricContext must never ride along
    // (the contract's strict object enforces it; the values prove the mapping).
    // The Avoid text projects VERBATIM, never the compiled negative terms.
    expect(data.vibe).toEqual({
      genreTags: ['techno', 'deep house'],
      energy: 'high',
      vocalMode: 'vocal',
      voiceGender: 'female',
      ownVoice: false,
      language: 'German',
      styleStrength: 0.9,
      novelty: 0.05,
      avoid: 'saxophone',
      userPrompt: 'dark warehouse techno',
      controls: null,
    });
    expect(data.switchPending).toBe(false);
  });

  it.each([
    ['on', 'true', true],
    ['off', '', false],
  ])('projects an own-voice opt-in only while the switch is %s', async (_label, flag, expected) => {
    vi.stubEnv('OWN_VOICE_ENABLED', flag);
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, {
      ownerUserId,
      styleSnapshot: { vocalMode: 'vocal', useOwnVoice: true },
    });
    expect((await callQueue(sessionId)).vibe?.ownVoice).toBe(expected);
  });

  it('reports the in-flight generation counts the route resolves for the player', async () => {
    // The route owns two inputs the view cannot derive: the shared
    // phantom-submit bound and the music provider's tracks per call. Getting
    // either wrong makes the player's "Generating" count silently 0.
    const base = await seedSession();
    expect((await callQueue(base.sessionId)).generatingTracksAhead).toBe(0);

    const requestId = await createGenerationRequest(testDb.db, {
      ownerUserId: base.ownerUserId,
      activitySessionId: base.sessionId,
      styleRevision: 1,
    });
    await createProviderJob(testDb.db, {
      generationRequestId: requestId,
      normalizedStatus: 'processing',
    });

    const data = await callQueue(base.sessionId);
    expect(data.generatingTracksAhead).toBe(TRACKS_PER_REQUEST);
    expect(data.generatingNewVibeTracksAhead).toBe(TRACKS_PER_REQUEST);
  });

  it('switchPending reflects an armed vibe switch', async () => {
    const base = await seedSession();
    expect((await callQueue(base.sessionId)).switchPending).toBe(false);

    await testDb.pool.query(
      `update activity_sessions set style_revision = 2, vibe_switch_revision = 2 where id = $1`,
      [base.sessionId],
    );
    expect((await callQueue(base.sessionId)).switchPending).toBe(true);
  });

  it('switchPending drops while no new-vibe fill can arrive for the armed switch', async () => {
    const base = await seedSession();
    const oldVibe = await seedQueuedTrack(base, 0);
    await testDb.db.update(tracks).set({ durationSeconds: 150 }).where(eq(tracks.id, oldVibe));
    await testDb.pool.query(
      `update activity_sessions
         set style_revision = 2, vibe_switch_revision = 2, target_duration_minutes = 2
       where id = $1`,
      [base.sessionId],
    );
    // At the duration target the revision's fill is blocked.
    expect((await callQueue(base.sessionId)).switchPending).toBe(false);

    await testDb.pool.query(
      `update activity_sessions
         set target_duration_minutes = null, session_mode = 'repeat'
       where id = $1`,
      [base.sessionId],
    );
    // In Repeat the revision's one owed fill is still to come…
    expect((await callQueue(base.sessionId)).switchPending).toBe(true);
    // …until it has been spent: a failed fill is not retried there.
    const failedFill = await createGenerationRequest(testDb.db, {
      ownerUserId: base.ownerUserId,
      activitySessionId: base.sessionId,
      styleRevision: 2,
    });
    await createProviderJob(testDb.db, {
      generationRequestId: failedFill,
      normalizedStatus: 'failed_final',
    });
    expect((await callQueue(base.sessionId)).switchPending).toBe(false);
  });

  it('switchPending drops while new music is paused and no new-vibe work is in flight', async () => {
    const base = await seedSession();
    await testDb.pool.query(
      `update activity_sessions set style_revision = 2, vibe_switch_revision = 2 where id = $1`,
      [base.sessionId],
    );
    await updateUsageLimits(testDb.db, { manualGenerationOnly: true });
    // The worker submits nothing while paused, so the owed fill cannot come.
    expect((await callQueue(base.sessionId)).switchPending).toBe(false);

    // Work already submitted still finishes, so the switch still comes.
    const inFlight = await createGenerationRequest(testDb.db, {
      ownerUserId: base.ownerUserId,
      activitySessionId: base.sessionId,
      styleRevision: 2,
    });
    const job = await createProviderJob(testDb.db, {
      generationRequestId: inFlight,
      normalizedStatus: 'processing',
    });
    expect((await callQueue(base.sessionId)).switchPending).toBe(true);

    // Once nothing is in flight, lifting the pause makes the owed fill come again.
    await testDb.pool.query(`delete from provider_jobs where id = $1`, [job]);
    await testDb.pool.query(`delete from generation_requests where id = $1`, [inFlight]);
    expect((await callQueue(base.sessionId)).switchPending).toBe(false);
    await updateUsageLimits(testDb.db, { manualGenerationOnly: false });
    expect((await callQueue(base.sessionId)).switchPending).toBe(true);
  });

  it('vibe is null without a snapshot; off-enum snapshot values project as null/defaults', async () => {
    const base = await seedSession();
    expect((await callQueue(base.sessionId)).vibe).toBeNull();

    const sessionId = await createSession(testDb.db, {
      ownerUserId: base.ownerUserId,
      status: 'stopped',
      styleSnapshot: { energy: 'frantic', voiceGender: 'robot' },
    });
    const { vibe } = await callQueue(sessionId);
    expect(vibe).toEqual({
      genreTags: [],
      energy: null,
      vocalMode: 'instrumental',
      voiceGender: null,
      ownVoice: false,
      language: '',
      // A snapshot from before Guardrails existed projects nulls, never a
      // made-up level — the overlay is what shows the domain defaults.
      styleStrength: null,
      novelty: null,
      avoid: '',
      userPrompt: null,
      controls: null,
    });
  });

  it('a controls-mode vibe projects its stored structured controls', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, {
      ownerUserId,
      styleSnapshot: { genreTags: ['jazz'], energy: 'low', vocalMode: 'instrumental' },
      structuredControls: { activity: 'Focus', mood: 'Calm', energy: 'low', genres: ['jazz'] },
    });
    const { vibe } = await callQueue(sessionId);
    expect(vibe?.controls).toEqual({
      activity: 'Focus',
      mood: 'Calm',
      energy: 'low',
      genres: ['jazz'],
    });
  });

  it('a stream-only (not yet downloaded) track pins only the stream and reports no analysis', async () => {
    const base = await seedSession();
    const trackId = await seedQueuedTrack(base, 0, {
      identity: { styleRevision: 1, targetBpm: 124, targetKey: 'A minor' },
      withFinal: false,
      withStream: true,
    });

    const item = (await callQueue(base.sessionId)).items[0]!;
    expect(item.assets).toEqual({ final: null, stream: `/api/audio/${trackId}?asset=stream` });
    expect(item.blendAnalysis).toBeNull(); // pending — never analyzed
  });

  it('a failed Track (its final never arrived) offers no audio, though its stream is still stored', async () => {
    const base = await seedSession();
    const trackId = await seedQueuedTrack(base, 0, { withFinal: false, withStream: true });
    await testDb.db.update(tracks).set({ status: 'failed' }).where(eq(tracks.id, trackId));

    const item = (await callQueue(base.sessionId)).items[0]!;
    expect(item.assets).toEqual({ final: null, stream: null });
    expect(item.track?.audioUrl).toBeNull();
  });

  it('a legacy (pre-plan) request reports a null identity — the plain-edge signal', async () => {
    const base = await seedSession();
    await seedQueuedTrack(base, 0, { identity: null });

    const item = (await callQueue(base.sessionId)).items[0]!;
    expect(item.targetBpm).toBeNull();
    expect(item.targetKey).toBeNull();
    expect(item.styleRevision).toBeNull();
  });

  it('OMITS a blendAnalysis whose analyzer version is stale', async () => {
    const base = await seedSession();
    await seedQueuedTrack(base, 0, {
      identity: { styleRevision: 1, targetBpm: 124, targetKey: 'A minor' },
      analysis: {
        analysisStatus: 'measured',
        analysisVersion: CURRENT_ANALYSIS_VERSION - 1,
      },
    });

    const item = (await callQueue(base.sessionId)).items[0]!;
    expect(item.blendAnalysis).toBeNull();
  });

  it('cold start: surfaces the in-flight generation stage + submittedAt while nothing is playable', async () => {
    const base = await seedSession();
    const submittedAt = new Date('2026-07-01T10:00:00Z');
    const requestId = await createGenerationRequest(testDb.db, {
      ownerUserId: base.ownerUserId,
      activitySessionId: base.sessionId,
      stylePrompt: 'secret style prompt — must never reach the browser',
    });
    await createProviderJob(testDb.db, {
      generationRequestId: requestId,
      normalizedStatus: 'processing',
      createdAt: submittedAt,
    });

    const data = await callQueue(base.sessionId);
    // Stage + timestamp + teased title ONLY (the strict contract schema rejects
    // extra keys, so a leaked task id / URL / prompt would fail the parse in
    // callQueue). No early title persisted yet → null.
    expect(data.pendingGeneration).toEqual({
      stage: 'generating',
      submittedAt: submittedAt.toISOString(),
      trackTitle: null,
    });
  });

  it('cold start: surfaces the persisted early track title for the tease', async () => {
    const base = await seedSession();
    const requestId = await createGenerationRequest(testDb.db, {
      ownerUserId: base.ownerUserId,
      activitySessionId: base.sessionId,
      earlyTrackTitle: 'Neon Sunset',
    });
    await createProviderJob(testDb.db, {
      generationRequestId: requestId,
      normalizedStatus: 'processing',
    });

    const data = await callQueue(base.sessionId);
    expect(data.pendingGeneration).toMatchObject({
      stage: 'generating',
      trackTitle: 'Neon Sunset',
    });
  });

  it('cold start: an unplayable queued track (no assets) still surfaces the pending generation', async () => {
    const base = await seedSession();
    await seedQueuedTrack(base, 0, { withFinal: false });
    const requestId = await createGenerationRequest(testDb.db, {
      ownerUserId: base.ownerUserId,
      activitySessionId: base.sessionId,
    });
    await createProviderJob(testDb.db, {
      generationRequestId: requestId,
      normalizedStatus: 'partially_ready',
    });

    const data = await callQueue(base.sessionId);
    expect(data.pendingGeneration).toMatchObject({ stage: 'finalizing' });
  });

  it('omits the pending generation once a playable track exists', async () => {
    const base = await seedSession();
    await seedQueuedTrack(base, 0, { withFinal: false, withStream: true });
    const requestId = await createGenerationRequest(testDb.db, {
      ownerUserId: base.ownerUserId,
      activitySessionId: base.sessionId,
    });
    await createProviderJob(testDb.db, {
      generationRequestId: requestId,
      normalizedStatus: 'processing',
    });

    const data = await callQueue(base.sessionId);
    expect(data.pendingGeneration).toBeNull();
  });

  it('omits the pending generation when the latest job failed (the banner owns failures)', async () => {
    const base = await seedSession();
    const requestId = await createGenerationRequest(testDb.db, {
      ownerUserId: base.ownerUserId,
      activitySessionId: base.sessionId,
    });
    await createProviderJob(testDb.db, {
      generationRequestId: requestId,
      normalizedStatus: 'failed_final',
    });

    const data = await callQueue(base.sessionId);
    expect(data.pendingGeneration).toBeNull();
  });

  it('omits an uncertain submit past its in-flight slot, so the stuck banner offers its actions', async () => {
    for (const [updatedAt, pending] of [
      [new Date(), true],
      [new Date(Date.now() - 24 * 60 * 60_000), false],
    ] as const) {
      const base = await seedSession();
      const requestId = await createGenerationRequest(testDb.db, {
        ownerUserId: base.ownerUserId,
        activitySessionId: base.sessionId,
      });
      await createProviderJob(testDb.db, {
        generationRequestId: requestId,
        submitState: 'submit_unknown',
        normalizedStatus: 'submit_unknown',
        providerTaskId: null,
        updatedAt,
      });

      const data = await callQueue(base.sessionId);
      if (pending) expect(data.pendingGeneration).toMatchObject({ stage: 'submitting' });
      else expect(data.pendingGeneration).toBeNull();
    }
  });

  it('offers Try again after a failed batch but not after a policy block', async () => {
    for (const [normalizedStatus, tryAgainTracks] of [
      ['failed_final', TRACKS_PER_REQUEST],
      ['blocked_by_policy', null],
    ] as const) {
      const base = await seedSession();
      const requestId = await createGenerationRequest(testDb.db, {
        ownerUserId: base.ownerUserId,
        activitySessionId: base.sessionId,
      });
      await createProviderJob(testDb.db, { generationRequestId: requestId, normalizedStatus });

      expect((await callQueue(base.sessionId)).tryAgainTracks).toBe(tryAgainTracks);
    }
  });

  it('a partial analysis (LUFS measured, BPM anchored) surfaces as status=partial', async () => {
    const base = await seedSession();
    await seedQueuedTrack(base, 0, {
      identity: { styleRevision: 1, targetBpm: 124, targetKey: 'A minor' },
      analysis: {
        analysisStatus: 'partial',
        analysisVersion: CURRENT_ANALYSIS_VERSION,
        bpmSource: 'anchored',
        lufsIntegrated: -12.5,
      },
    });

    const item = (await callQueue(base.sessionId)).items[0]!;
    expect(item.blendAnalysis).toMatchObject({
      status: 'partial',
      bpmSource: 'anchored',
      integratedLufs: -12.5,
    });
  });
});
