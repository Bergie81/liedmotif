import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { activitySessionQueueItems, trackAudioAssets, tracks } from '../schema';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';
import {
  upsertProviderTrackWithAssets,
  type ProviderTrackUpsertContext,
} from './provider-results-repo';
import { writeDownloadedTrackAudio } from './tracks-repo';
import { decryptSourceUrl } from './source-url-crypto';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;
const KEY = randomBytes(32);
const STREAM_URL = 'https://cdn.example/stream/6ee24fe5-78bf-46da-b717-37d35ece5fb5';
const FINAL_URL = 'https://cdn.example/final/6ee24fe5-78bf-46da-b717-37d35ece5fb5.mp3';

describeIfDb('provider-results repo (idempotent track/asset/queue upsert)', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-provider-results-repo-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  async function jobContext(): Promise<ProviderTrackUpsertContext> {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const generationRequestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const providerJobId = await createProviderJob(ctx.db, {
      generationRequestId,
      normalizedStatus: 'partially_ready',
    });
    return {
      ownerUserId,
      generationRequestId,
      providerJobId,
      activitySessionId: sessionId,
      providerKey: 'mock',
      prompt: 'instrumental lofi, low energy',
      encryptionKey: KEY,
    };
  }

  async function assets(trackId: string) {
    return ctx.db
      .select({
        assetType: trackAudioAssets.assetType,
        encryptedSourceUrl: trackAudioAssets.encryptedSourceUrl,
        storageKey: trackAudioAssets.storageKey,
        isPlayable: trackAudioAssets.isPlayable,
      })
      .from(trackAudioAssets)
      .where(eq(trackAudioAssets.trackId, trackId));
  }

  async function queueItems(sessionId: string) {
    return ctx.db
      .select({
        position: activitySessionQueueItems.position,
        state: activitySessionQueueItems.state,
        trackId: activitySessionQueueItems.trackId,
      })
      .from(activitySessionQueueItems)
      .where(eq(activitySessionQueueItems.activitySessionId, sessionId))
      .orderBy(activitySessionQueueItems.position);
  }

  it('two overlapping upserts for the same (job, track) create exactly one row of each', async () => {
    const c = await jobContext();
    const track = {
      providerTrackId: 'ptrack-A',
      streamAudioUrl: STREAM_URL,
      audioUrl: FINAL_URL,
      durationSeconds: 168,
    };
    // Run two materializations of the SAME track concurrently (overlap, not re-run).
    const [a, b] = await Promise.all([
      upsertProviderTrackWithAssets(ctx.db, { ...c, track }),
      upsertProviderTrackWithAssets(ctx.db, { ...c, track }),
    ]);

    expect(a.trackId).toBe(b.trackId);
    // Each transition is reported by EXACTLY ONE of the two overlapping runs.
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect([a.insertedProviderStream, b.insertedProviderStream].filter(Boolean)).toHaveLength(1);
    expect([a.insertedProviderFinal, b.insertedProviderFinal].filter(Boolean)).toHaveLength(1);
    expect([a.insertedQueueItem, b.insertedQueueItem].filter(Boolean)).toHaveLength(1);
    // Exactly one row of each in the DB — no double assets, no duplicate queue item.
    expect(await ctx.db.select().from(tracks)).toHaveLength(1);
    expect(await assets(a.trackId)).toHaveLength(2);
    expect(await queueItems(c.activitySessionId!)).toHaveLength(1);
  });

  it('two jobs of one Session materializing at once get distinct Queue positions', async () => {
    const c = await jobContext();
    for (let round = 0; round < 5; round += 1) {
      const generationRequestId = await createGenerationRequest(ctx.db, {
        ownerUserId: c.ownerUserId,
        activitySessionId: c.activitySessionId!,
      });
      const providerJobId = await createProviderJob(ctx.db, {
        generationRequestId,
        normalizedStatus: 'partially_ready',
      });
      await Promise.all([
        upsertProviderTrackWithAssets(ctx.db, {
          ...c,
          track: { providerTrackId: `a-${round}`, streamAudioUrl: STREAM_URL },
        }),
        upsertProviderTrackWithAssets(ctx.db, {
          ...c,
          generationRequestId,
          providerJobId,
          track: { providerTrackId: `b-${round}`, streamAudioUrl: STREAM_URL },
        }),
      ]);
    }
    const positions = (await queueItems(c.activitySessionId!)).map((item) => item.position);
    expect(positions).toEqual([...positions.keys()]);
  });

  it('reports a DURABLE needsDownload from current asset state (crash/retry recovery)', async () => {
    const c = await jobContext();
    const track = { providerTrackId: 'ptrack-A', streamAudioUrl: STREAM_URL, audioUrl: FINAL_URL };

    // First materialization: the final asset is inserted AND a download is needed.
    const first = await upsertProviderTrackWithAssets(ctx.db, { ...c, track });
    expect(first).toMatchObject({ insertedProviderFinal: true, needsDownload: true });

    // Reprocess (simulating a retry after the download enqueue was lost): the final
    // asset already exists so it is NOT inserted this call, but the download is still
    // NEEDED (no local_original) — so the follow-up can be re-derived and recovered.
    const second = await upsertProviderTrackWithAssets(ctx.db, { ...c, track });
    expect(second).toMatchObject({ insertedProviderFinal: false, needsDownload: true });

    // Once the local original lands, the durable need clears.
    await writeDownloadedTrackAudio(ctx.db, {
      trackId: first.trackId,
      storageKey: `tracks/o/${first.trackId}/original.mp3`,
    });
    const third = await upsertProviderTrackWithAssets(ctx.db, { ...c, track });
    expect(third.needsDownload).toBe(false);
  });

  it('a stream-only track never needs a download', async () => {
    const c = await jobContext();
    const r = await upsertProviderTrackWithAssets(ctx.db, {
      ...c,
      track: { providerTrackId: 'ptrack-S', streamAudioUrl: STREAM_URL },
    });
    expect(r.needsDownload).toBe(false);
  });

  it('creates a streamable track with an encrypted provider_stream asset and a queued item', async () => {
    const c = await jobContext();
    const r = await upsertProviderTrackWithAssets(ctx.db, {
      ...c,
      track: {
        providerTrackId: 'ptrack-A',
        title: 'Paper Notes',
        streamAudioUrl: STREAM_URL,
      },
    });
    expect(r).toMatchObject({
      created: true,
      insertedProviderStream: true,
      insertedProviderFinal: false,
      insertedQueueItem: true,
    });

    const [track] = await ctx.db.select().from(tracks).where(eq(tracks.id, r.trackId));
    expect(track).toMatchObject({
      providerKey: 'mock',
      providerTrackId: 'ptrack-A',
      title: 'Paper Notes',
      status: 'streamable',
      ownerUserId: c.ownerUserId,
    });

    const a = await assets(r.trackId);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      assetType: 'provider_stream',
      isPlayable: true,
      storageKey: null,
    });
    // The URL is encrypted at rest — never stored in plaintext.
    expect(a[0]!.encryptedSourceUrl).not.toContain('cdn.example');
    expect(decryptSourceUrl(a[0]!.encryptedSourceUrl!, KEY)).toBe(STREAM_URL);

    const q = await queueItems(c.activitySessionId!);
    expect(q).toEqual([{ position: 0, state: 'queued', trackId: r.trackId }]);
  });

  it('adds a non-playable encrypted provider_final asset on a later poll (no duplicate track/queue item)', async () => {
    const c = await jobContext();
    const first = await upsertProviderTrackWithAssets(ctx.db, {
      ...c,
      track: { providerTrackId: 'ptrack-A', streamAudioUrl: STREAM_URL },
    });
    // Second poll: the same track now also has a final URL.
    const second = await upsertProviderTrackWithAssets(ctx.db, {
      ...c,
      track: {
        providerTrackId: 'ptrack-A',
        streamAudioUrl: STREAM_URL,
        audioUrl: FINAL_URL,
        durationSeconds: 168,
      },
    });
    expect(second).toMatchObject({
      trackId: first.trackId,
      created: false,
      insertedProviderStream: false, // the stream asset already existed
      insertedProviderFinal: true, // the final asset is new this poll
      insertedQueueItem: false, // the queue item already existed
    });

    const a = await assets(first.trackId);
    const byType = Object.fromEntries(a.map((x) => [x.assetType, x]));
    expect(a).toHaveLength(2);
    expect(byType.provider_stream).toMatchObject({ isPlayable: true });
    expect(byType.provider_final).toMatchObject({ isPlayable: false });
    expect(decryptSourceUrl(byType.provider_final!.encryptedSourceUrl!, KEY)).toBe(FINAL_URL);

    // Exactly one track row and one queue item survive the repeat.
    const allTracks = await ctx.db.select().from(tracks);
    expect(allTracks).toHaveLength(1);
    expect(await queueItems(c.activitySessionId!)).toHaveLength(1);
  });

  it('backfills the Track duration when a later final result supplies it', async () => {
    const c = await jobContext();
    const first = await upsertProviderTrackWithAssets(ctx.db, {
      ...c,
      track: { providerTrackId: 'ptrack-A', streamAudioUrl: STREAM_URL },
    });

    await upsertProviderTrackWithAssets(ctx.db, {
      ...c,
      track: {
        providerTrackId: 'ptrack-A',
        streamAudioUrl: STREAM_URL,
        audioUrl: FINAL_URL,
        durationSeconds: 168.08,
      },
    });

    const [track] = await ctx.db
      .select({ durationSeconds: tracks.durationSeconds })
      .from(tracks)
      .where(eq(tracks.id, first.trackId));
    expect(track?.durationSeconds).toBe(168);
  });

  it('is fully idempotent: an identical re-process creates no second row of anything', async () => {
    const c = await jobContext();
    const track = { providerTrackId: 'ptrack-A', streamAudioUrl: STREAM_URL, audioUrl: FINAL_URL };
    const a = await upsertProviderTrackWithAssets(ctx.db, { ...c, track });
    const b = await upsertProviderTrackWithAssets(ctx.db, { ...c, track });
    expect(b.trackId).toBe(a.trackId);
    expect(b.created).toBe(false);

    expect(await ctx.db.select().from(tracks)).toHaveLength(1);
    expect(await assets(a.trackId)).toHaveLength(2);
    expect(await queueItems(c.activitySessionId!)).toHaveLength(1);
  });

  it('stamps the request vibe genre tags on the track at first materialization', async () => {
    const c = await jobContext();
    const track = { providerTrackId: 'ptrack-A', streamAudioUrl: STREAM_URL };
    const a = await upsertProviderTrackWithAssets(ctx.db, {
      ...c,
      genreTags: ['lofi', ' Chillhop ', '', 'lofi'],
      track,
    });
    const [row] = await ctx.db
      .select({ genreTags: tracks.genreTags })
      .from(tracks)
      .where(eq(tracks.id, a.trackId));
    expect(row!.genreTags).toEqual(['lofi', 'chillhop']);

    // A later poll without tags never clears what the first materialization wrote.
    await upsertProviderTrackWithAssets(ctx.db, { ...c, track });
    const [again] = await ctx.db
      .select({ genreTags: tracks.genreTags })
      .from(tracks)
      .where(eq(tracks.id, a.trackId));
    expect(again!.genreTags).toEqual(['lofi', 'chillhop']);
  });

  it('stamps vocalMode and lyrics on a vocal materialization', async () => {
    const c = await jobContext();
    const a = await upsertProviderTrackWithAssets(ctx.db, {
      ...c,
      vocalMode: 'vocal',
      track: {
        providerTrackId: 'ptrack-A',
        streamAudioUrl: STREAM_URL,
        lyrics: '[Verse]\nNeon rain on the window',
      },
    });
    const [row] = await ctx.db
      .select({ vocalMode: tracks.vocalMode, lyrics: tracks.lyrics })
      .from(tracks)
      .where(eq(tracks.id, a.trackId));
    expect(row).toEqual({ vocalMode: 'vocal', lyrics: '[Verse]\nNeon rain on the window' });
  });

  it('never stores lyrics for an instrumental materialization (provider filler text)', async () => {
    const c = await jobContext();
    const a = await upsertProviderTrackWithAssets(ctx.db, {
      ...c,
      vocalMode: 'instrumental',
      track: {
        providerTrackId: 'ptrack-A',
        streamAudioUrl: STREAM_URL,
        lyrics: 'a calm lofi description echoed back',
      },
    });
    const [row] = await ctx.db
      .select({ vocalMode: tracks.vocalMode, lyrics: tracks.lyrics })
      .from(tracks)
      .where(eq(tracks.id, a.trackId));
    expect(row).toEqual({ vocalMode: 'instrumental', lyrics: null });
  });

  it('backfills lyrics write-once when a later poll supplies them', async () => {
    const c = await jobContext();
    const first = await upsertProviderTrackWithAssets(ctx.db, {
      ...c,
      vocalMode: 'vocal',
      track: { providerTrackId: 'ptrack-A', streamAudioUrl: STREAM_URL },
    });

    await upsertProviderTrackWithAssets(ctx.db, {
      ...c,
      vocalMode: 'vocal',
      track: { providerTrackId: 'ptrack-A', streamAudioUrl: STREAM_URL, lyrics: 'First words' },
    });
    // A later reprocess with different text never overwrites captured lyrics.
    await upsertProviderTrackWithAssets(ctx.db, {
      ...c,
      vocalMode: 'vocal',
      track: { providerTrackId: 'ptrack-A', streamAudioUrl: STREAM_URL, lyrics: 'Changed words' },
    });

    const [row] = await ctx.db
      .select({ lyrics: tracks.lyrics })
      .from(tracks)
      .where(eq(tracks.id, first.trackId));
    expect(row!.lyrics).toBe('First words');
  });

  it('places sibling tracks at consecutive queue positions', async () => {
    const c = await jobContext();
    const a = await upsertProviderTrackWithAssets(ctx.db, {
      ...c,
      track: { providerTrackId: 'ptrack-A', streamAudioUrl: STREAM_URL },
    });
    const b = await upsertProviderTrackWithAssets(ctx.db, {
      ...c,
      track: { providerTrackId: 'ptrack-B', streamAudioUrl: STREAM_URL },
    });
    const q = await queueItems(c.activitySessionId!);
    expect(q).toEqual([
      { position: 0, state: 'queued', trackId: a.trackId },
      { position: 1, state: 'queued', trackId: b.trackId },
    ]);
  });
});
