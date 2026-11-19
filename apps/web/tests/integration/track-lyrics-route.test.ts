import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { tracks, usageEvents } from '@liedmotif/db';
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
import type { MusicProvider, TimedLyrics } from '@liedmotif/providers';

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));

/** A controllable music-provider stub; tests program the two lyric methods. */
const providerStub = vi.hoisted(() => ({
  providerKey: 'mock',
  getGenerationStatus: vi.fn(),
  getTimestampedLyrics: vi.fn(),
}));
vi.mock('@/lib/providers/providers', () => ({
  getMusicProvider: () => providerStub as unknown as MusicProvider,
}));

const { GET } = await import('@/app/api/tracks/[trackId]/lyrics/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

const LYRICS = '[Verse]\nNeon rain on the window\n[Chorus]\nKeep the loop alive';
const TIMED: TimedLyrics = {
  words: [
    { word: '[Verse]\n', startSeconds: 0, endSeconds: 0.4, success: false },
    { word: 'Neon rain on the window\n', startSeconds: 6.1, endSeconds: 8.2, success: true },
    { word: '[Chorus]\n', startSeconds: 8.2, endSeconds: 8.3, success: false },
    { word: 'Keep the loop alive\n', startSeconds: 12.5, endSeconds: 15.1, success: true },
  ],
  alignmentErrorScore: 0.05,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function getLyrics(trackId: string) {
  return GET(new Request(`http://localhost/api/tracks/${trackId}/lyrics`), {
    params: Promise.resolve({ trackId }),
  });
}

async function seedTrack(opts: {
  vocalMode?: 'instrumental' | 'vocal';
  lyrics?: string | null;
  timedLyrics?: TimedLyrics | null;
  jobStatus?: string;
  providerTaskId?: string | null;
}) {
  const ownerUserId = await createUser(testDb.db);
  holder.ownerUserId = ownerUserId;
  const sessionId = await createSession(testDb.db, { ownerUserId });
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const providerJobId = await createProviderJob(testDb.db, {
    generationRequestId: requestId,
    normalizedStatus: opts.jobStatus ?? 'ready',
    ...(opts.providerTaskId !== undefined ? { providerTaskId: opts.providerTaskId } : {}),
  });
  const trackId = await createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId,
    providerTrackId: `audio-${Math.random().toString(36).slice(2)}`,
    vocalMode: opts.vocalMode ?? 'vocal',
    lyrics: opts.lyrics ?? null,
    timedLyrics: opts.timedLyrics ?? null,
  });
  return { ownerUserId, trackId };
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('track-lyrics-route-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, GENERATION_FIXTURE_TABLES);
  holder.ownerUserId = null;
  providerStub.getGenerationStatus.mockReset();
  providerStub.getTimestampedLyrics.mockReset();
});

describe.skipIf(skip)('GET /api/tracks/[trackId]/lyrics', () => {
  it('404s a malformed id and a cross-owner track alike', async () => {
    const { trackId } = await seedTrack({});
    expect((await getLyrics('not-a-uuid')).status).toBe(404);

    holder.ownerUserId = await createUser(testDb.db); // someone else
    expect((await getLyrics(trackId)).status).toBe(404);
  });

  it('reports an instrumental track without touching the provider', async () => {
    const { trackId } = await seedTrack({ vocalMode: 'instrumental' });
    const response = await getLyrics(trackId);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual({ state: 'instrumental', lines: [], synced: false, settled: true });
    expect(providerStub.getGenerationStatus).not.toHaveBeenCalled();
    expect(providerStub.getTimestampedLyrics).not.toHaveBeenCalled();
  });

  it('is pending while the job is still in flight (the worker will deliver the words)', async () => {
    const { trackId } = await seedTrack({ jobStatus: 'processing' });
    const body = await (await getLyrics(trackId)).json();
    expect(body.data).toEqual({ state: 'pending', lines: [], synced: false, settled: false });
    expect(providerStub.getGenerationStatus).not.toHaveBeenCalled();
  });

  it('leaves an in-flight job with captured words unsettled (timing still on the way)', async () => {
    const { trackId } = await seedTrack({ lyrics: LYRICS, jobStatus: 'processing' });
    const body = await (await getLyrics(trackId)).json();
    expect(body.data.state).toBe('ready');
    expect(body.data.synced).toBe(false);
    expect(body.data.settled).toBe(false);
    expect(body.data.lines.length).toBeGreaterThan(0);
    // The paid timing call stays reserved for a completed job.
    expect(providerStub.getTimestampedLyrics).not.toHaveBeenCalled();
  });

  it.each(['failed_final', 'blocked_by_provider_credits', 'blocked_by_policy'])(
    'settles once the job can no longer deliver timing (%s)',
    async (jobStatus) => {
      const { trackId } = await seedTrack({ lyrics: LYRICS, jobStatus });
      const body = await (await getLyrics(trackId)).json();
      expect(body.data.state).toBe('ready');
      expect(body.data.settled).toBe(true);
      expect(providerStub.getTimestampedLyrics).not.toHaveBeenCalled();
    },
  );

  it('serves cached lyrics + timing as synced lines without any provider call', async () => {
    const { trackId } = await seedTrack({ lyrics: LYRICS, timedLyrics: TIMED });
    const body = await (await getLyrics(trackId)).json();
    expect(body.data.state).toBe('ready');
    expect(body.data.synced).toBe(true);
    expect(body.data.lines).toEqual([
      { kind: 'section', label: 'Verse' },
      { kind: 'line', text: 'Neon rain on the window', timeSeconds: 6.1 },
      { kind: 'section', label: 'Chorus' },
      { kind: 'line', text: 'Keep the loop alive', timeSeconds: 12.5 },
    ]);
    expect(providerStub.getGenerationStatus).not.toHaveBeenCalled();
    expect(providerStub.getTimestampedLyrics).not.toHaveBeenCalled();
  });

  it('backfills plain lyrics and fetches timing ONCE for a completed job, then caches both', async () => {
    const { trackId } = await seedTrack({ lyrics: null });
    const [row] = await testDb.db
      .select({ providerTrackId: tracks.providerTrackId })
      .from(tracks)
      .where(eq(tracks.id, trackId));
    providerStub.getGenerationStatus.mockResolvedValue({
      status: 'complete',
      tracks: [{ providerTrackId: row!.providerTrackId, lyrics: LYRICS }],
      provider: { providerType: 'music', providerKey: 'mock' },
    });
    providerStub.getTimestampedLyrics.mockResolvedValue(TIMED);

    const body = await (await getLyrics(trackId)).json();
    expect(body.data.state).toBe('ready');
    expect(body.data.synced).toBe(true);

    // Both enrichments persisted…
    const [persisted] = await testDb.db
      .select({ lyrics: tracks.lyrics, timedLyrics: tracks.timedLyrics })
      .from(tracks)
      .where(eq(tracks.id, trackId));
    expect(persisted!.lyrics).toBe(LYRICS);
    expect(persisted!.timedLyrics).toEqual(TIMED);
    // …the paid call is on the spend ledger…
    const events = await testDb.db.select().from(usageEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: 'timestamped_lyrics', units: 1 });
    // …and a second open is a pure DB read.
    await getLyrics(trackId);
    expect(providerStub.getGenerationStatus).toHaveBeenCalledTimes(1);
    expect(providerStub.getTimestampedLyrics).toHaveBeenCalledTimes(1);
  });

  it('pays for at most one timing fetch under concurrent opens (panel + sheet)', async () => {
    const { trackId } = await seedTrack({ lyrics: LYRICS });
    providerStub.getTimestampedLyrics.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(TIMED), 25)),
    );

    const [a, b] = await Promise.all([getLyrics(trackId), getLyrics(trackId)]);
    expect((await a.json()).data.synced).toBe(true);
    expect((await b.json()).data.synced).toBe(true);
    expect(providerStub.getTimestampedLyrics).toHaveBeenCalledTimes(1);
  });

  it('pays for one timing fetch when a second open read the track before the first persisted', async () => {
    const { trackId } = await seedTrack({ lyrics: null });
    const [row] = await testDb.db
      .select({ providerTrackId: tracks.providerTrackId })
      .from(tracks)
      .where(eq(tracks.id, trackId));
    const status = {
      status: 'complete',
      tracks: [{ providerTrackId: row!.providerTrackId, lyrics: LYRICS }],
      provider: { providerType: 'music', providerKey: 'mock' },
    };
    const first = deferred<typeof status>();
    const second = deferred<typeof status>();
    providerStub.getGenerationStatus
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    providerStub.getTimestampedLyrics.mockResolvedValue(TIMED);

    // Both opens read the track (no lyrics, no timing) before either backfill lands.
    const a = getLyrics(trackId);
    const b = getLyrics(trackId);
    await vi.waitFor(() => expect(providerStub.getGenerationStatus).toHaveBeenCalledTimes(2));
    first.resolve(status);
    expect((await (await a).json()).data.synced).toBe(true);
    second.resolve(status);
    expect((await (await b).json()).data.synced).toBe(true);

    expect(providerStub.getTimestampedLyrics).toHaveBeenCalledTimes(1);
    expect(await testDb.db.select().from(usageEvents)).toHaveLength(1);
  });

  it('caches a provider "no timing" answer so the paid call is never repeated', async () => {
    const { trackId } = await seedTrack({ lyrics: LYRICS });
    providerStub.getTimestampedLyrics.mockResolvedValue(null);

    const body = await (await getLyrics(trackId)).json();
    expect(body.data.state).toBe('ready');
    expect(body.data.synced).toBe(false);
    // The cached "no timing" answer is final — nothing left to poll for.
    expect(body.data.settled).toBe(true);

    await getLyrics(trackId);
    expect(providerStub.getTimestampedLyrics).toHaveBeenCalledTimes(1);
  });

  it('degrades to unsynced on a timing failure and persists nothing (retryable)', async () => {
    const { trackId } = await seedTrack({ lyrics: LYRICS });
    providerStub.getTimestampedLyrics.mockRejectedValue(new Error('sanitized'));

    const body = await (await getLyrics(trackId)).json();
    expect(body.data.state).toBe('ready');
    expect(body.data.synced).toBe(false);
    expect(body.data.lines.length).toBeGreaterThan(0);

    const [persisted] = await testDb.db
      .select({ timedLyrics: tracks.timedLyrics })
      .from(tracks)
      .where(eq(tracks.id, trackId));
    expect(persisted!.timedLyrics).toBeNull();

    // The next open retries the fetch.
    await getLyrics(trackId);
    expect(providerStub.getTimestampedLyrics).toHaveBeenCalledTimes(2);
  });

  it('settles to ready-with-no-lines when a completed job has nothing to backfill', async () => {
    const { trackId } = await seedTrack({ lyrics: null });
    providerStub.getGenerationStatus.mockResolvedValue({
      status: 'complete',
      tracks: [],
      provider: { providerType: 'music', providerKey: 'mock' },
    });
    const body = await (await getLyrics(trackId)).json();
    expect(body.data).toEqual({ state: 'ready', lines: [], synced: false, settled: true });
  });

  it('serves only what is stored on a cached read, never reaching the provider (offline sync)', async () => {
    // An offline sync reads every vocal Track of a Playlist; enrichment there
    // would buy timing for Tracks nobody opened.
    const { trackId } = await seedTrack({ lyrics: LYRICS });
    const response = await GET(
      new Request(`http://localhost/api/tracks/${trackId}/lyrics?cached=1`),
      { params: Promise.resolve({ trackId }) },
    );

    const body = await response.json();
    expect(body.data.state).toBe('ready');
    expect(body.data.synced).toBe(false);
    expect(body.data.lines.length).toBeGreaterThan(0);
    expect(providerStub.getGenerationStatus).not.toHaveBeenCalled();
    expect(providerStub.getTimestampedLyrics).not.toHaveBeenCalled();
  });
});
