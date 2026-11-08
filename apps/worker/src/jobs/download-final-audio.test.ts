import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  activitySessions,
  deletionQueueItems,
  getSessionDurationProgress,
  getStorageUsage,
  ORPHANED_DOWNLOAD_REASON,
  refreshStorageUsage,
  rejectDislikedTrack,
  trackAudioAssets,
  tracks,
  updateUsageLimits,
} from '@liedmotif/db';
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
} from '@liedmotif/db/testing';
import { getGenerationStats, upsertProviderTrackWithAssets } from '@liedmotif/db';
import { createMockStorageProvider, storageKeys, type MockStorage } from '@liedmotif/storage';
import { pcmToWav, sineWave } from '../audio/analysis-fixtures';
import { isFfmpegAvailable } from '../audio/ffmpeg';
import { runDownloadFinalAudio } from './download-final-audio';
import { runProcessDeletionQueue } from './process-deletion-queue';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;
const ffmpegAvailable = await isFfmpegAvailable();
const KEY = randomBytes(32);
const STREAM_URL = 'https://cdn.example/stream/A';
const FINAL_URL = 'https://cdn.example/final/A.mp3';
const BYTES = Buffer.from(Array.from({ length: 64 }, (_, i) => i % 256));

/** A fetch that returns the given bytes/content-type, recording the URL it was asked for. */
function fakeFetch(opts: { bytes?: Buffer; contentType?: string; ok?: boolean } = {}) {
  return vi.fn(async (_url: string) => {
    if (opts.ok === false) return new Response('nope', { status: 502 });
    return new Response(opts.bytes ?? BYTES, {
      status: 200,
      headers: { 'content-type': opts.contentType ?? 'audio/mpeg' },
    });
  }) as unknown as typeof fetch;
}

describeIfDb('download-final-audio', () => {
  let ctx: TestDb;
  let store: MockStorage;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-download-final-test');
    store = createMockStorageProvider();
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
    await store?.cleanup();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, [...GENERATION_FIXTURE_TABLES, 'app_settings']);
  });

  /** The canonical key the download writes: fixture session/track titles are null,
   *  so the segments fall back to `session-`/`track-` + the short id. */
  function expectedKey(ownerUserId: string, sessionId: string, trackId: string, ext: string) {
    return storageKeys.trackOriginal(
      ownerUserId,
      storageKeys.sessionAudioFolder({ id: sessionId, title: null }),
      { id: trackId, title: null },
      ext,
    );
  }

  /** Stage a streamable track with encrypted provider stream + (optional) final
   *  assets — in a fresh session, or in `opts.in`'s existing one. */
  async function stagedTrack(
    opts: {
      withFinal?: boolean;
      finalUrl?: string;
      in?: { ownerUserId: string; sessionId: string };
    } = {},
  ): Promise<{ trackId: string; ownerUserId: string; sessionId: string }> {
    const ownerUserId = opts.in?.ownerUserId ?? (await createUser(ctx.db));
    const sessionId = opts.in?.sessionId ?? (await createSession(ctx.db, { ownerUserId }));
    const generationRequestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const providerJobId = await createProviderJob(ctx.db, { generationRequestId });
    const r = await upsertProviderTrackWithAssets(ctx.db, {
      ownerUserId,
      generationRequestId,
      providerJobId,
      activitySessionId: sessionId,
      providerKey: 'mock',
      prompt: 'instrumental lofi',
      encryptionKey: KEY,
      track: {
        providerTrackId: opts.in ? 'ptrack-B' : 'ptrack-A',
        streamAudioUrl: STREAM_URL,
        durationSeconds: 168,
        ...(opts.withFinal !== false ? { audioUrl: opts.finalUrl ?? FINAL_URL } : {}),
      },
    });
    return { trackId: r.trackId, ownerUserId, sessionId };
  }

  function deps(fetchImpl: typeof fetch, enqueueAnalyze = vi.fn(async () => {})) {
    return {
      db: ctx.db,
      storage: store.provider,
      fetchImpl,
      encryptionKey: KEY,
      enqueueAnalyze,
      enqueueEmbedMetadata: vi.fn(async () => {}),
      // The egress guard resolves the fixture host without touching real DNS.
      resolveHostAddresses: async () => ['93.184.216.34'],
    };
  }

  it.skipIf(!ffmpegAvailable)(
    'measures missing provider duration from stored audio for Session accounting',
    async () => {
      const { trackId, ownerUserId, sessionId } = await stagedTrack();
      await ctx.db.update(tracks).set({ durationSeconds: null }).where(eq(tracks.id, trackId));
      const bytes = pcmToWav(sineWave(440, 3, 0.2, 44100), 44100);
      const result = await runDownloadFinalAudio(
        deps(fakeFetch({ bytes, contentType: 'audio/wav' })),
        { trackId },
      );
      expect(result.outcome).toBe('downloaded');
      expect(await getSessionDurationProgress(ctx.db, { ownerUserId, sessionId })).toEqual({
        generatedDurationSeconds: 3,
        unknownDurationTrackCount: 0,
        batchOutstanding: true,
      });
    },
  );

  it('keeps audio playable when duration measurement cannot resolve metadata', async () => {
    const { trackId, ownerUserId, sessionId } = await stagedTrack();
    await ctx.db.update(tracks).set({ durationSeconds: null }).where(eq(tracks.id, trackId));
    expect((await runDownloadFinalAudio(deps(fakeFetch()), { trackId })).outcome).toBe(
      'downloaded',
    );
    expect(await getSessionDurationProgress(ctx.db, { ownerUserId, sessionId })).toEqual({
      generatedDurationSeconds: 0,
      unknownDurationTrackCount: 1,
      batchOutstanding: true,
    });
  });

  it('freezes the session audio folder at first download — a rename cannot split it', async () => {
    const a = await stagedTrack();
    const b = await stagedTrack({ in: a, finalUrl: 'https://cdn.example/final/B.mp3' });
    await ctx.db
      .update(activitySessions)
      .set({ title: 'Focus Beats' })
      .where(eq(activitySessions.id, a.sessionId));

    const r1 = await runDownloadFinalAudio(deps(fakeFetch()), { trackId: a.trackId });
    expect(r1.outcome).toBe('downloaded');
    expect(r1.storageKey).toContain('/focus-beats-');

    // A Rename lands between the two downloads.
    await ctx.db
      .update(activitySessions)
      .set({ title: 'Midnight Run' })
      .where(eq(activitySessions.id, a.sessionId));

    const r2 = await runDownloadFinalAudio(deps(fakeFetch()), { trackId: b.trackId });
    expect(r2.outcome).toBe('downloaded');
    const folderOf = (key: string) => key.split('/').slice(0, 3).join('/');
    expect(folderOf(r2.storageKey!)).toBe(folderOf(r1.storageKey!));
  });

  it('decrypts the final URL, stores bytes under the track key, flips to ready, and queues analysis', async () => {
    const { trackId, ownerUserId, sessionId } = await stagedTrack();
    const fetchImpl = fakeFetch();
    const enqueueAnalyze = vi.fn(async () => {});

    const r = await runDownloadFinalAudio(deps(fetchImpl, enqueueAnalyze), { trackId });
    expect(r.outcome).toBe('downloaded');

    // The fetch targeted the DECRYPTED provider URL (server-side only), pinned
    // to the addresses the egress guard vetted.
    expect(fetchImpl).toHaveBeenCalledWith(FINAL_URL, expect.anything(), expect.any(Array));

    const key = expectedKey(ownerUserId, sessionId, trackId, 'mp3');
    const stat = await store.provider.stat(key);
    expect(stat?.byteSize).toBe(BYTES.length);

    const [track] = await ctx.db.select().from(tracks).where(eq(tracks.id, trackId));
    expect(track!.status).toBe('ready');
    expect(enqueueAnalyze).toHaveBeenCalledWith(trackId);
  });

  it('claims quota room for the download and settles it with the bytes that landed', async () => {
    // The claim is a defensible maximum, far above the fixture: if it were not
    // given back, the next download would find the quota full.
    const a = await stagedTrack();
    const b = await stagedTrack({ in: a, finalUrl: 'https://cdn.example/final/B.mp3' });
    // A delta, not an absolute: the measured total sums the whole database, and
    // this suite truncates only the tables its own fixtures touch.
    const { totalBytes: before } = await refreshStorageUsage(ctx.db);

    expect((await runDownloadFinalAudio(deps(fakeFetch()), { trackId: a.trackId })).outcome).toBe(
      'downloaded',
    );
    const usage = await getStorageUsage(ctx.db);
    expect(usage?.totalBytes).toBe(before + BYTES.length);
    expect(usage?.reservedBytes).toBe(0);
    expect((await runDownloadFinalAudio(deps(fakeFetch()), { trackId: b.trackId })).outcome).toBe(
      'downloaded',
    );
  });

  it('refuses a provider body that declares more than one track may be', async () => {
    const { trackId, ownerUserId, sessionId } = await stagedTrack();
    const fetchImpl = vi.fn(
      async () =>
        new Response(BYTES, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': String(1024 ** 4) },
        }),
    ) as unknown as typeof fetch;

    await expect(
      runDownloadFinalAudio(
        // Unbounded free space, so the byte ceiling is the only thing that can
        // refuse this and the assertion cannot pass for the volume's reasons.
        { ...deps(fetchImpl), storage: { ...store.provider, freeBytes: async () => 1024 ** 5 } },
        { trackId },
      ),
    ).rejects.toThrow(/exceeded/);
    expect(
      await store.provider.stat(expectedKey(ownerUserId, sessionId, trackId, 'mp3')),
    ).toBeNull();
  });

  it('defers the download when the storage quota has no room for it', async () => {
    const { trackId } = await stagedTrack();
    await updateUsageLimits(ctx.db, { storageQuotaBytes: 0 });
    await refreshStorageUsage(ctx.db);

    const fetchImpl = fakeFetch();
    await expect(runDownloadFinalAudio(deps(fetchImpl), { trackId })).rejects.toThrow(
      /storage quota/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('persists an allowlisted content type when the provider declares a hostile one', async () => {
    const { trackId, ownerUserId, sessionId } = await stagedTrack();

    const r = await runDownloadFinalAudio(deps(fakeFetch({ contentType: 'text/html' })), {
      trackId,
    });
    expect(r.outcome).toBe('downloaded');

    // Persisting `text/html` verbatim is what makes the audio route echo it back
    // as markup in the app origin; the stored type stays inside the audio set.
    const [asset] = await ctx.db
      .select()
      .from(trackAudioAssets)
      .where(
        and(
          eq(trackAudioAssets.trackId, trackId),
          eq(trackAudioAssets.assetType, 'local_original'),
        ),
      );
    expect(asset!.mimeType).toBe('audio/mpeg');
    expect(asset!.storageKey).toBe(expectedKey(ownerUserId, sessionId, trackId, 'mp3'));
  });

  it('BLOCKING 3 — two overlapping downloads fetch + write + flip + enqueue exactly once', async () => {
    const { trackId } = await stagedTrack();
    // ONE shared fetch stub + analyze spy across both concurrent runs, so we can prove
    // the work happened exactly once under overlap.
    const fetchImpl = fakeFetch();
    const enqueueAnalyze = vi.fn(async () => {});
    const d = deps(fetchImpl, enqueueAnalyze);

    const results = await Promise.all([
      runDownloadFinalAudio(d, { trackId }),
      runDownloadFinalAudio(d, { trackId }),
    ]);

    // Exactly one job did the work; the other was the no-op loser.
    expect(results.filter((r) => r.outcome === 'downloaded')).toHaveLength(1);
    // At most one real provider fetch (no wasteful double-download).
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    // Exactly one ready-flip and one analyze enqueue.
    expect(enqueueAnalyze).toHaveBeenCalledTimes(1);
    const [track] = await ctx.db.select().from(tracks).where(eq(tracks.id, trackId));
    expect(track!.status).toBe('ready');
  });

  it('is idempotent: a second run does not re-download or re-queue analysis', async () => {
    const { trackId } = await stagedTrack();
    await runDownloadFinalAudio(deps(fakeFetch()), { trackId });

    const secondFetch = fakeFetch();
    const enqueueAnalyze = vi.fn(async () => {});
    const r = await runDownloadFinalAudio(deps(secondFetch, enqueueAnalyze), { trackId });
    expect(r.outcome).toBe('already_downloaded');
    expect(secondFetch).not.toHaveBeenCalled();
    expect(enqueueAnalyze).not.toHaveBeenCalled();
  });

  it('picks the file extension from the response content type', async () => {
    const { trackId, ownerUserId, sessionId } = await stagedTrack();
    await runDownloadFinalAudio(deps(fakeFetch({ contentType: 'audio/mp4' })), { trackId });
    const key = expectedKey(ownerUserId, sessionId, trackId, 'm4a');
    expect(await store.provider.stat(key)).not.toBeNull();
  });

  it('throws on a failed fetch so Graphile retries (no asset written, track stays streamable)', async () => {
    const { trackId } = await stagedTrack();
    await expect(
      runDownloadFinalAudio(deps(fakeFetch({ ok: false })), { trackId }),
    ).rejects.toThrow();
    const [track] = await ctx.db.select().from(tracks).where(eq(tracks.id, trackId));
    expect(track!.status).toBe('streamable');
  });

  it('throws on an empty body so Graphile retries (no 0-byte final, nothing left in storage)', async () => {
    const { trackId, ownerUserId, sessionId } = await stagedTrack();
    await expect(
      runDownloadFinalAudio(deps(fakeFetch({ bytes: Buffer.alloc(0) })), { trackId }),
    ).rejects.toThrow();
    const [track] = await ctx.db.select().from(tracks).where(eq(tracks.id, trackId));
    expect(track!.status).toBe('streamable');
    expect(
      await store.provider.stat(expectedKey(ownerUserId, sessionId, trackId, 'mp3')),
    ).toBeNull();
  });

  it('a given-up download is a storage failure: the Track stays generated and no attempt failed', async () => {
    const { trackId, ownerUserId } = await stagedTrack();
    const generation = () =>
      getGenerationStats(ctx.db, {
        ownerUserId,
        range: 'all',
        now: new Date(),
        timezone: 'UTC',
      });

    // A failure Graphile will retry says nothing yet.
    await expect(
      runDownloadFinalAudio(deps(fakeFetch({ ok: false })), { trackId }),
    ).rejects.toThrow();
    expect((await generation()).storageFailures).toBe(0);

    await expect(
      runDownloadFinalAudio(deps(fakeFetch({ ok: false })), { trackId }, { finalAttempt: true }),
    ).rejects.toThrow();
    expect(await generation()).toMatchObject({
      generatedTracks: 1,
      storageFailures: 1,
      failedAttempts: 0,
    });

    // A revived download that lands withdraws the failure.
    await runDownloadFinalAudio(deps(fakeFetch()), { trackId });
    expect(await generation()).toMatchObject({ generatedTracks: 1, storageFailures: 0 });
  });

  it('cancels a non-OK response body before throwing (no dangling upstream connection)', async () => {
    const { trackId } = await stagedTrack();
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(
      async () => new Response(endless, { status: 502 }),
    ) as unknown as typeof fetch;

    await expect(runDownloadFinalAudio(deps(fetchImpl), { trackId })).rejects.toThrow();
    expect(cancelled).toBe(true);
  });

  it('blocks a provider final URL pointing at a private/metadata host: no fetch, URL-free error', async () => {
    const { trackId } = await stagedTrack({ finalUrl: 'http://169.254.169.254/latest/meta-data' });
    const fetchImpl = fakeFetch();

    const error = await runDownloadFinalAudio(deps(fetchImpl), { trackId }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    // The egress guard refused BEFORE any network I/O, with a sanitized error.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((error as Error).message).not.toContain('169.254.169.254');

    const [track] = await ctx.db.select().from(tracks).where(eq(tracks.id, trackId));
    expect(track!.status).toBe('streamable');
  });

  it('aborts a hung provider download after the timeout with a URL-free error (lock/slot not pinned)', async () => {
    const { trackId } = await stagedTrack();
    // Settles ONLY when the adapter's timeout signal aborts — a slow-drip CDN stand-in.
    const hungFetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error));
        }),
    ) as unknown as typeof fetch;

    const error = await runDownloadFinalAudio(
      { ...deps(hungFetch), downloadTimeoutMs: 25 },
      { trackId },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    // Sanitized: the decrypted provider URL never rides the thrown error.
    expect((error as Error).message).not.toContain('cdn.example');
    expect((error as Error).message).toMatch(/timeout|transport/i);

    // The transaction rolled back: no asset landed, the track stays retryable.
    const [track] = await ctx.db.select().from(tracks).where(eq(tracks.id, trackId));
    expect(track!.status).toBe('streamable');
  });

  it('aborts a download whose body starts but never finishes: rollback, no bytes, no temp file, no URL leak', async () => {
    const { trackId, ownerUserId, sessionId } = await stagedTrack();
    // The stub wires the job's timeout signal to the body stream, as real undici
    // does: the abort errors the stream MID-WRITE, so `storage.write` rejects.
    const trickleFetch = vi.fn((_url: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(BYTES.subarray(0, 8));
          init?.signal?.addEventListener('abort', () =>
            controller.error(init.signal!.reason as Error),
          );
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
      );
    }) as unknown as typeof fetch;

    const error = await runDownloadFinalAudio(
      { ...deps(trickleFetch), downloadTimeoutMs: 25 },
      { trackId },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    // The abort surfaces through `storage.write`; the storage layer never sees
    // the decrypted provider URL, so the thrown error must not carry it either.
    expect((error as Error).message).not.toContain('cdn.example');

    // Rollback: the track stays retryable, nothing landed at the canonical key,
    // and the atomic-write temp file was removed.
    const [track] = await ctx.db.select().from(tracks).where(eq(tracks.id, trackId));
    expect(track!.status).toBe('streamable');
    const key = expectedKey(ownerUserId, sessionId, trackId, 'mp3');
    expect(await store.provider.stat(key)).toBeNull();
    const leftovers = (await readdir(store.dataRoot, { recursive: true })).filter((entry) =>
      String(entry).endsWith('.tmp'),
    );
    expect(leftovers).toEqual([]);
  });

  it('is a no-op when there is no final asset yet (stream-only track)', async () => {
    const { trackId } = await stagedTrack({ withFinal: false });
    const fetchImpl = fakeFetch();
    const r = await runDownloadFinalAudio(deps(fetchImpl), { trackId });
    expect(r.outcome).toBe('no_final');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is a no-op for a missing track', async () => {
    const r = await runDownloadFinalAudio(deps(fakeFetch()), {
      trackId: '00000000-0000-0000-0000-000000000000',
    });
    expect(r.outcome).toBe('missing');
  });

  it('queues the just-written file for deletion when the track is Disliked mid-fetch (no orphaned bytes)', async () => {
    const { trackId, ownerUserId, sessionId } = await stagedTrack();
    // The dislike commits WHILE the provider fetch is in flight — after the
    // download's under-lock status re-check, before the bytes land. The reject's
    // asset snapshot runs before the local file exists, so nothing else ever
    // queues this key.
    const fetchImpl = vi.fn(async () => {
      const rejected = await rejectDislikedTrack(ctx.db, { ownerUserId, trackId });
      expect(rejected?.alreadyDisliked).toBe(false);
      return new Response(BYTES, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }) as unknown as typeof fetch;
    const enqueueAnalyze = vi.fn(async () => {});

    const r = await runDownloadFinalAudio(deps(fetchImpl, enqueueAnalyze), { trackId });
    // Downloaded-then-declined reports `discarded`, never a landed `downloaded`.
    expect(r.outcome).toBe('discarded');

    // The DB declined the asset: no resurrection, no asset row, no analysis.
    const [track] = await ctx.db.select().from(tracks).where(eq(tracks.id, trackId));
    expect(track!.status).toBe('rejected');
    expect(enqueueAnalyze).not.toHaveBeenCalled();

    // The written object is on disk but queued for immediate deletion...
    const key = expectedKey(ownerUserId, sessionId, trackId, 'mp3');
    expect(await store.provider.stat(key)).not.toBeNull();
    const queued = await ctx.db
      .select()
      .from(deletionQueueItems)
      .where(eq(deletionQueueItems.storageKey, key));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.reason).toBe(ORPHANED_DOWNLOAD_REASON);

    // ...and the deletion consumer actually reclaims the bytes.
    const drained = await runProcessDeletionQueue({ db: ctx.db, storage: store.provider });
    expect(drained.deleted).toBeGreaterThanOrEqual(1);
    expect(await store.provider.stat(key)).toBeNull();
  });

  it('queues the just-written file for deletion when the owner is deleted mid-fetch', async () => {
    const { trackId, ownerUserId, sessionId } = await stagedTrack();
    // A Member delete cascades the owner and track rows away while the bytes stream.
    const fetchImpl = vi.fn(async () => {
      await ctx.pool.query('delete from "user" where id = $1', [ownerUserId]);
      return new Response(BYTES, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }) as unknown as typeof fetch;

    const r = await runDownloadFinalAudio(deps(fetchImpl), { trackId });
    expect(r.outcome).toBe('discarded');

    const key = expectedKey(ownerUserId, sessionId, trackId, 'mp3');
    const drained = await runProcessDeletionQueue({ db: ctx.db, storage: store.provider });
    expect(drained.deleted).toBeGreaterThanOrEqual(1);
    expect(await store.provider.stat(key)).toBeNull();
  });
});
