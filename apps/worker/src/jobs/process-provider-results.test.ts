import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activitySessions,
  activitySessionQueueItems,
  generationRequests,
  getProviderJobForPoll,
  tracks,
  type ProviderJobForPoll,
  type StyleSnapshot,
} from '@liedmotif/db';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createQueueSlotAtRevision,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import {
  mockMusicProvider,
  type MusicGenerationStatusResult,
  type NormalizedTrack,
} from '@liedmotif/providers';
import {
  createProcessProviderResultsTask,
  runProcessProviderResults,
} from './process-provider-results';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;
const KEY = randomBytes(32);

const STREAM_A = 'https://cdn.example/stream/A';
const FINAL_A = 'https://cdn.example/final/A.mp3';
const STREAM_B = 'https://cdn.example/stream/B';

describeIfDb('process-provider-results', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-process-results-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  async function job(
    normalizedStatus = 'partially_ready',
    opts: {
      styleSnapshot?: StyleSnapshot;
      requestStyleSnapshot?: StyleSnapshot;
      titleSeed?: number;
      requestStyleRevision?: number;
    } = {},
  ): Promise<{ job: ProviderJobForPoll; sessionId: string }> {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      ...(opts.styleSnapshot ? { styleSnapshot: opts.styleSnapshot } : {}),
    });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      ...(opts.requestStyleSnapshot ? { styleSnapshot: opts.requestStyleSnapshot } : {}),
      ...(opts.titleSeed !== undefined ? { titleSeed: opts.titleSeed } : {}),
      ...(opts.requestStyleRevision !== undefined
        ? { styleRevision: opts.requestStyleRevision }
        : {}),
    });
    const jobId = await createProviderJob(ctx.db, {
      generationRequestId: requestId,
      normalizedStatus,
    });
    return { job: (await getProviderJobForPoll(ctx.db, jobId))!, sessionId };
  }

  function deps(overrides?: {
    enqueueDownload?: (trackId: string) => Promise<void>;
    enqueueBuffer?: (sessionId: string) => Promise<void>;
  }) {
    return {
      db: ctx.db,
      encryptionKey: KEY,
      enqueueDownload: overrides?.enqueueDownload ?? vi.fn(async () => {}),
      enqueueBuffer: overrides?.enqueueBuffer ?? vi.fn(async () => {}),
    };
  }

  const SIBLINGS: NormalizedTrack[] = [
    {
      providerTrackId: 'A',
      title: 'Paper Notes',
      streamAudioUrl: STREAM_A,
      audioUrl: FINAL_A,
      durationSeconds: 168,
    },
    { providerTrackId: 'B', title: 'Paper Notes', streamAudioUrl: STREAM_B }, // stream-only sibling
  ];

  it('materializes both siblings, enqueues a download only for the final, and one buffer refill', async () => {
    const { job: j, sessionId } = await job();
    const enqueueDownload = vi.fn(async () => {});
    const enqueueBuffer = vi.fn(async () => {});

    const result = await runProcessProviderResults(deps({ enqueueDownload, enqueueBuffer }), {
      job: j,
      tracks: SIBLINGS,
    });

    expect(result.processedTrackIds).toHaveLength(2);
    const rows = await ctx.db.select().from(tracks);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'streamable')).toBe(true);

    const q = await ctx.db
      .select({ position: activitySessionQueueItems.position })
      .from(activitySessionQueueItems)
      .where(eq(activitySessionQueueItems.activitySessionId, sessionId));
    expect(q).toHaveLength(2);

    // One download enqueued (only the sibling that has a final URL).
    expect(enqueueDownload).toHaveBeenCalledTimes(1);
    expect(enqueueBuffer).toHaveBeenCalledTimes(1);
    expect(enqueueBuffer).toHaveBeenCalledWith(sessionId);
  });

  it('an armed vibe switch cuts over when this run materializes the first playable new-vibe track', async () => {
    const { job: j, sessionId } = await job('partially_ready', { requestStyleRevision: 2 });
    const ownerUserId = j.ownerUserId!;
    await ctx.db
      .update(activitySessions)
      .set({ styleRevision: 2, vibeSwitchRevision: 2 })
      .where(eq(activitySessions.id, sessionId));
    // One OLD-vibe (revision 1) streamable track already queued at position 0.
    await createQueueSlotAtRevision(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      styleRevision: 1,
      position: 0,
    });

    await runProcessProviderResults(deps(), { job: j, tracks: SIBLINGS });

    const items = await ctx.db
      .select({
        position: activitySessionQueueItems.position,
        state: activitySessionQueueItems.state,
      })
      .from(activitySessionQueueItems)
      .where(eq(activitySessionQueueItems.activitySessionId, sessionId));
    const byPosition = items.sort((a, b) => a.position - b.position);
    expect(byPosition[0]).toMatchObject({ position: 0, state: 'skipped' });
    expect(byPosition.slice(1).every((item) => item.state === 'queued')).toBe(true);
    const [session] = await ctx.db
      .select({ vibeSwitchRevision: activitySessions.vibeSwitchRevision })
      .from(activitySessions)
      .where(eq(activitySessions.id, sessionId));
    expect(session!.vibeSwitchRevision).toBeNull();
  });

  it('CRASH-RECOVERY — re-enqueues a still-needed download on reprocess', async () => {
    const { job: j } = await job();
    // First process commits the provider_final asset (and would enqueue the download).
    await runProcessProviderResults(deps(), { job: j, tracks: SIBLINGS });

    // Simulate the retry AFTER the enqueue was lost (worker crash / addJob failure
    // between the asset commit and the enqueue): fresh spies, reprocess the SAME state.
    // The final asset already exists (not inserted this call) but the download is still
    // owed — so it MUST be re-enqueued (durable need), not skipped forever.
    const enqueueDownload = vi.fn(async () => {});
    const r = await runProcessProviderResults(deps({ enqueueDownload }), {
      job: j,
      tracks: SIBLINGS,
    });
    expect(enqueueDownload).toHaveBeenCalledTimes(1); // sibling A still needs its download
    expect(r.downloadsEnqueued).toHaveLength(1);
  });

  it('NO-SPAM — re-enqueue is bounded by the stable jobKey (≤ one pending per track/session)', async () => {
    const { job: j, sessionId } = await job();
    // Model Graphile's jobKey dedup (default `replace` → at most one pending per key):
    // the stable `download:<trackId>` / `buffer:<sessionId>` keys collapse repeats.
    const pendingDownloads = new Set<string>();
    const pendingBuffers = new Set<string>();
    const enqueueDownload = vi.fn(async (trackId: string) => {
      pendingDownloads.add(`download:${trackId}`);
    });
    const enqueueBuffer = vi.fn(async (s: string) => {
      pendingBuffers.add(`buffer:${s}`);
    });

    for (let i = 0; i < 3; i += 1) {
      await runProcessProviderResults(deps({ enqueueDownload, enqueueBuffer }), {
        job: j,
        tracks: SIBLINGS,
      });
    }

    // Recovery: the enqueue runs on EVERY reprocess so a lost one always recovers...
    expect(enqueueDownload.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(enqueueBuffer.mock.calls.length).toBeGreaterThanOrEqual(3);
    // ...but the stable jobKey collapses them: at most one pending download per track
    // (only sibling A has a final) and one buffer refill per session — no runaway spam.
    expect(pendingDownloads.size).toBe(1);
    expect(pendingBuffers).toEqual(new Set([`buffer:${sessionId}`]));
  });

  it('is idempotent: processing the same poll result twice creates exactly one row of each', async () => {
    const { job: j, sessionId } = await job();
    await runProcessProviderResults(deps(), { job: j, tracks: SIBLINGS });
    await runProcessProviderResults(deps(), { job: j, tracks: SIBLINGS });

    expect(await ctx.db.select().from(tracks)).toHaveLength(2);
    const q = await ctx.db
      .select()
      .from(activitySessionQueueItems)
      .where(eq(activitySessionQueueItems.activitySessionId, sessionId));
    expect(q).toHaveLength(2);
  });

  it('a reprocess with no new work (nothing created, no download owed) enqueues no buffer refill', async () => {
    const { job: j } = await job();
    const streamOnly: NormalizedTrack[] = [
      { providerTrackId: 'A', streamAudioUrl: STREAM_A },
      { providerTrackId: 'B', streamAudioUrl: STREAM_B },
    ];
    const first = deps();
    await runProcessProviderResults(first, { job: j, tracks: streamOnly });
    expect(first.enqueueBuffer).toHaveBeenCalledTimes(1);

    // Everything is already durable and no download is owed: the reprocess must
    // not re-fire the buffer tick (or the vibe-switch cutover) for a no-op.
    const second = deps();
    const r = await runProcessProviderResults(second, { job: j, tracks: streamOnly });
    expect(r.processedTrackIds).toHaveLength(2);
    expect(second.enqueueBuffer).not.toHaveBeenCalled();
  });

  /** A music provider whose `getGenerationStatus` returns a fixed recovery result. */
  function scriptedMusic(status: MusicGenerationStatusResult['status']) {
    let calls = 0;
    const music = {
      ...mockMusicProvider(),
      async getGenerationStatus(): Promise<MusicGenerationStatusResult> {
        calls += 1;
        return {
          status,
          tracks:
            status === 'complete'
              ? [{ providerTrackId: 'A', streamAudioUrl: STREAM_A, audioUrl: FINAL_A }]
              : [],
          provider: { providerType: 'music' as const, providerKey: 'mock' },
        };
      },
    };
    return { music, calls: () => calls };
  }

  function taskHelpers() {
    const addJob = vi.fn(
      async (
        _identifier: string,
        _payload?: { trackId?: string },
        _opts?: { jobKey?: string },
      ) => {},
    );
    return { addJob };
  }

  it('VIBE TAGS — stamps the REQUEST snapshot genre tags on materialized tracks', async () => {
    // The request's own snapshot wins: after a Change Vibe the session snapshot
    // describes the new vibe while this track still belongs to its own.
    const { job: j } = await job('partially_ready', {
      styleSnapshot: { stylePrompt: 'house party', genreTags: ['house'] },
      requestStyleSnapshot: { stylePrompt: 'lofi beats', genreTags: ['lofi', 'chillhop'] },
    });
    await runProcessProviderResults(deps(), {
      job: j,
      tracks: [{ providerTrackId: 'ptrack-A', streamAudioUrl: STREAM_A }],
    });
    const [row] = await ctx.db.select({ genreTags: tracks.genreTags }).from(tracks);
    expect(row!.genreTags).toEqual(['lofi', 'chillhop']);
  });

  it('VIBE TAGS — falls back to the session snapshot for requests predating their own', async () => {
    const { job: j } = await job('partially_ready', {
      styleSnapshot: { stylePrompt: 'house party', genreTags: ['house'] },
    });
    await runProcessProviderResults(deps(), {
      job: j,
      tracks: [{ providerTrackId: 'ptrack-A', streamAudioUrl: STREAM_A }],
    });
    const [row] = await ctx.db.select({ genreTags: tracks.genreTags }).from(tracks);
    expect(row!.genreTags).toEqual(['house']);
  });

  it('LYRICS — a vocal request stamps vocalMode and the provider-written lyrics', async () => {
    const { job: j } = await job('partially_ready', {
      requestStyleSnapshot: { stylePrompt: 'synth pop', vocalMode: 'vocal' },
    });
    await runProcessProviderResults(deps(), {
      job: j,
      tracks: [
        {
          providerTrackId: 'ptrack-A',
          streamAudioUrl: STREAM_A,
          lyrics: '[Verse]\nNeon rain on the window',
        },
      ],
    });
    const [row] = await ctx.db
      .select({ vocalMode: tracks.vocalMode, lyrics: tracks.lyrics })
      .from(tracks);
    expect(row).toEqual({ vocalMode: 'vocal', lyrics: '[Verse]\nNeon rain on the window' });
  });

  it('LYRICS — an instrumental request never stores the provider filler text', async () => {
    const { job: j } = await job('partially_ready', {
      requestStyleSnapshot: { stylePrompt: 'lofi beats', vocalMode: 'instrumental' },
    });
    await runProcessProviderResults(deps(), {
      job: j,
      tracks: [{ providerTrackId: 'ptrack-A', streamAudioUrl: STREAM_A, lyrics: '[Instrumental]' }],
    });
    const [row] = await ctx.db
      .select({ vocalMode: tracks.vocalMode, lyrics: tracks.lyrics })
      .from(tracks);
    expect(row).toEqual({ vocalMode: 'instrumental', lyrics: null });
  });

  it('the task enqueues the download with a stable download:<trackId> jobKey (Graphile dedup)', async () => {
    // Recovery contract: the standalone task only ever runs for a job the poll drove
    // `ready`, so stage exactly that.
    const { job: j } = await job('ready');
    const { music } = scriptedMusic('complete');
    const { addJob } = taskHelpers();
    const task = createProcessProviderResultsTask({
      db: ctx.db,
      getMusic: async () => music,
      encryptionKey: KEY,
    });
    await task({ providerJobId: j.jobId }, { addJob } as unknown as Parameters<typeof task>[1]);

    // The download is enqueued with jobKey = `download:<the materialized trackId>` (the
    // default `replace` mode then guarantees at most one pending download per track).
    const downloadCall = addJob.mock.calls.find((c) => c[0] === 'download-final-audio');
    expect(downloadCall).toBeDefined();
    const [, payload, opts] = downloadCall!;
    expect(opts?.jobKey).toBe(`download:${payload?.trackId}`);
  });

  it('GUARD — the task is a no-op for a job that is not ready (never materializes off-contract)', async () => {
    const { job: j } = await job('partially_ready');
    const { music, calls } = scriptedMusic('complete');
    const { addJob } = taskHelpers();
    const task = createProcessProviderResultsTask({
      db: ctx.db,
      getMusic: async () => music,
      encryptionKey: KEY,
    });
    await task({ providerJobId: j.jobId }, { addJob } as unknown as Parameters<typeof task>[1]);

    // The provider is never re-read and nothing is materialized: in-flight jobs are
    // the poll loop's job, failed jobs must not grow tracks.
    expect(calls()).toBe(0);
    expect(await ctx.db.select().from(tracks)).toHaveLength(0);
    expect(addJob).not.toHaveBeenCalled();
  });

  it('GUARD — throws (so Graphile retries) when the provider re-read of a ready job is not complete', async () => {
    const { job: j } = await job('ready');
    const { music } = scriptedMusic('text_ready');
    const { addJob } = taskHelpers();
    const task = createProcessProviderResultsTask({
      db: ctx.db,
      getMusic: async () => music,
      encryptionKey: KEY,
    });

    await expect(
      task({ providerJobId: j.jobId }, { addJob } as unknown as Parameters<typeof task>[1]),
    ).rejects.toThrow(/retrying recovery/);
    expect(await ctx.db.select().from(tracks)).toHaveLength(0);
  });

  it('DISTINCT SIBLINGS — derives per-track titles from the request index (no pool)', async () => {
    const { job: j } = await job('partially_ready', {
      styleSnapshot: { stylePrompt: 'lofi beats', titleScheme: 'focus' },
      titleSeed: 3,
    });
    await runProcessProviderResults(deps(), { job: j, tracks: SIBLINGS });

    const rows = await ctx.db.select({ title: tracks.title }).from(tracks);
    // Ordinals 3*2+0 and 3*2+1 — the provider's shared echo title is replaced.
    expect(new Set(rows.map((r) => r.title))).toEqual(new Set(['Focus 7', 'Focus 8']));
  });

  it('DISTINCT SIBLINGS — uses the creative track-title pool when the snapshot has one', async () => {
    const { job: j } = await job('partially_ready', {
      styleSnapshot: {
        stylePrompt: 'lofi beats',
        trackTitles: ['Amber Rain', 'Night Signal', 'Paper Tide'],
      },
      titleSeed: 0,
    });
    await runProcessProviderResults(deps(), { job: j, tracks: SIBLINGS });

    const rows = await ctx.db.select({ title: tracks.title }).from(tracks);
    expect(new Set(rows.map((r) => r.title))).toEqual(new Set(['Amber Rain', 'Night Signal']));
  });

  it("DISTINCT SIBLINGS — names from the session's pool once a refill grew it past the request's copy", async () => {
    const { job: j } = await job('partially_ready', {
      styleSnapshot: {
        stylePrompt: 'lofi beats',
        trackTitles: ['Amber Rain', 'Night Signal', 'Paper Tide', 'Glass Avenue'],
      },
      requestStyleSnapshot: {
        stylePrompt: 'lofi beats',
        trackTitles: ['Amber Rain', 'Night Signal'],
      },
      titleSeed: 1,
    });
    await runProcessProviderResults(deps(), { job: j, tracks: SIBLINGS });

    const rows = await ctx.db.select({ title: tracks.title }).from(tracks);
    expect(new Set(rows.map((r) => r.title))).toEqual(new Set(['Paper Tide', 'Glass Avenue']));
  });

  it('CHANGE VIBE MID-FLIGHT — titles and facets both come from the frozen request snapshot', async () => {
    // The user hit Change Vibe while this request was still in flight, so the
    // session snapshot already describes the NEW vibe. Titles must follow the
    // same rule the facets do, or the track is named for a vibe it was never
    // generated under — and `onConflictDoNothing` freezes that permanently.
    const { job: j } = await job('partially_ready', {
      styleSnapshot: { stylePrompt: 'house party', genreTags: ['house'], titleScheme: 'motion' },
      requestStyleSnapshot: {
        stylePrompt: 'lofi beats',
        genreTags: ['lofi'],
        titleScheme: 'focus',
      },
      titleSeed: 3,
    });
    await runProcessProviderResults(deps(), { job: j, tracks: SIBLINGS });

    const rows = await ctx.db
      .select({ title: tracks.title, genreTags: tracks.genreTags })
      .from(tracks);
    expect(new Set(rows.map((r) => r.title))).toEqual(new Set(['Focus 7', 'Focus 8']));
    expect(rows.every((r) => r.genreTags?.[0] === 'lofi')).toBe(true);
  });

  it('DISTINCT SIBLINGS — a partial poll mints the same ordinals as the full one', async () => {
    const { job: j } = await job('partially_ready', {
      styleSnapshot: { stylePrompt: 'lofi beats', titleScheme: 'focus' },
      titleSeed: 1,
    });
    // Suno FIRST_SUCCESS: only sibling A is playable yet. The ordinal multiplier
    // must be requestedTrackCount (2), not the 1 track visible this poll —
    // otherwise A gets ordinal 1*1=1 ("Focus 2"), colliding with request 0's
    // second track, and onConflictDoNothing freezes the collision forever.
    await runProcessProviderResults(deps(), { job: j, tracks: [SIBLINGS[0]!] });
    // SUCCESS: the full sibling list arrives on the next poll.
    await runProcessProviderResults(deps(), { job: j, tracks: SIBLINGS });

    const rows = await ctx.db.select({ title: tracks.title }).from(tracks);
    // Ordinals 1*2+0 and 1*2+1 on both polls — stable and collision-free.
    expect(new Set(rows.map((r) => r.title))).toEqual(new Set(['Focus 3', 'Focus 4']));
  });

  it('keeps provider titles as-is on a request predating the title seed', async () => {
    const { job: j } = await job(); // fixture default: no titleSeed, no snapshot
    await runProcessProviderResults(deps(), { job: j, tracks: SIBLINGS });

    const rows = await ctx.db.select({ title: tracks.title }).from(tracks);
    expect(rows.map((r) => r.title)).toEqual(['Paper Notes', 'Paper Notes']);
  });

  it('skips a track that has no playable URL yet (no row, no queue item)', async () => {
    const { job: j } = await job();
    const result = await runProcessProviderResults(deps(), {
      job: j,
      tracks: [{ providerTrackId: 'C' }], // neither stream nor final URL
    });
    expect(result.processedTrackIds).toHaveLength(0);
    expect(await ctx.db.select().from(tracks)).toHaveLength(0);
  });

  it('never materializes a playable track that has no provider track id', async () => {
    // Tracks are keyed by (provider, provider track id) across all owners, so
    // an empty id would merge every id-less track into one shared row.
    const { job: first } = await job();
    const { job: second } = await job();
    for (const [j, url] of [
      [first, STREAM_A],
      [second, STREAM_B],
    ] as const) {
      const result = await runProcessProviderResults(deps(), {
        job: j,
        tracks: [{ providerTrackId: '', streamAudioUrl: url }],
      });
      expect(result.processedTrackIds).toHaveLength(0);
    }
    expect(await ctx.db.select().from(tracks)).toHaveLength(0);
  });

  // The early title tease: the FIRST track's display title is
  // persisted on the request the moment the provider reports per-track data
  // (the text stage), before any playable audio exists, so the queue endpoint
  // can narrate "Composing '<title>'…" during the cold start.
  describe('EARLY TITLE TEASE', () => {
    async function earlyTitle(): Promise<string | null> {
      const [row] = await ctx.db
        .select({ earlyTrackTitle: generationRequests.earlyTrackTitle })
        .from(generationRequests);
      return row!.earlyTrackTitle;
    }

    /** Suno TEXT_SUCCESS shape: per-track entries (shared echo title), no URLs. */
    const TEXT_STAGE_TRACKS: NormalizedTrack[] = [
      { providerTrackId: 'A', title: 'Echo Title' },
      { providerTrackId: 'B', title: 'Echo Title' },
    ];

    it('a text-stage poll persists the DERIVED first-track title before any audio exists', async () => {
      const { job: j } = await job('processing', {
        styleSnapshot: { stylePrompt: 'lofi beats', titleScheme: 'focus' },
        titleSeed: 3,
      });
      await runProcessProviderResults(deps(), { job: j, tracks: TEXT_STAGE_TRACKS });

      // The tease obeys the sibling-title derivation (seed 3 → ordinal 6 →
      // "Focus 7"), NOT the provider's echo title — and no track row exists yet.
      expect(await earlyTitle()).toBe('Focus 7');
      expect(await ctx.db.select().from(tracks)).toHaveLength(0);
    });

    it('the teased title matches the title the materialized track ends up with', async () => {
      const { job: j } = await job('processing', {
        styleSnapshot: { stylePrompt: 'lofi beats', titleScheme: 'focus' },
        titleSeed: 1,
      });
      await runProcessProviderResults(deps(), { job: j, tracks: TEXT_STAGE_TRACKS });
      const teased = await earlyTitle();

      await runProcessProviderResults(deps(), { job: j, tracks: SIBLINGS });
      const rows = await ctx.db.select({ title: tracks.title }).from(tracks);
      expect(teased).not.toBeNull();
      expect(rows.map((r) => r.title)).toContain(teased);
    });

    it('falls back to the provider title on a request predating the title seed', async () => {
      const { job: j } = await job(); // no titleSeed, no snapshot
      await runProcessProviderResults(deps(), { job: j, tracks: TEXT_STAGE_TRACKS });
      expect(await earlyTitle()).toBe('Echo Title');
    });

    it('is write-once: a later poll never changes a teased title (no flicker)', async () => {
      const { job: j } = await job(); // provider-title fallback path
      await runProcessProviderResults(deps(), { job: j, tracks: TEXT_STAGE_TRACKS });
      await runProcessProviderResults(deps(), {
        job: j,
        tracks: [{ providerTrackId: 'A', title: 'Renamed Later' }],
      });
      expect(await earlyTitle()).toBe('Echo Title');
    });

    it('degrades gracefully: empty per-track data (instrumental text stage) persists nothing', async () => {
      const { job: j } = await job();
      await runProcessProviderResults(deps(), { job: j, tracks: [] });
      expect(await earlyTitle()).toBeNull();

      await runProcessProviderResults(deps(), {
        job: j,
        tracks: [{ providerTrackId: 'A', title: '   ' }], // blank provider title
      });
      expect(await earlyTitle()).toBeNull();
    });
  });
});
