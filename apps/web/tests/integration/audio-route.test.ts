import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { localFsStorageProvider, type StorageProvider } from '@liedmotif/storage';
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

// Owner-authorized audio byte route (local-final serving path). Streams the
// DOWNLOADED local-final asset of a track OWNED by the caller, with HTTP Range
// support, and never leaks a provider/local-fs path. A cross-owner or not-yet-
// downloaded track is indistinguishable from a missing one (404), so a guessed
// id reveals nothing.

// Mutable holders the `@/lib/*` mocks read at call time.
const holder = vi.hoisted(() => ({
  db: null as unknown,
  storage: null as unknown,
  ownerUserId: null as string | null,
}));

vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/providers', () => ({ getStorageProvider: () => holder.storage }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));

const { GET } = await import('@/app/api/audio/[trackId]/route');

const skip = !TEST_DATABASE_URL;
const BODY = Buffer.from(Array.from({ length: 20 }, (_, i) => i)); // 20 known bytes
let testDb: TestDb;
let dataRoot: string;
let storage: StorageProvider;

let keyCounter = 0;
/** Stage an owned track whose downloaded local-final asset holds `BODY` bytes. */
async function seedOwnedTrackWithAudio(
  ownerUserId: string,
  audioMimeType?: string,
): Promise<{ trackId: string; key: string }> {
  keyCounter += 1;
  const key = `tracks/${ownerUserId}/asset-${keyCounter}/original.mp3`;
  await storage.write({ key, body: BODY, mimeType: 'audio/mpeg' });
  const sessionId = await createSession(testDb.db, { ownerUserId });
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  const trackId = await createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId: jobId,
    audioStorageKey: key,
    ...(audioMimeType ? { audioMimeType } : {}),
  });
  return { trackId, key };
}

/** Stage an owned track that has NO audio asset yet (final not downloaded). */
async function seedOwnedTrackNoAudio(ownerUserId: string): Promise<string> {
  const sessionId = await createSession(testDb.db, { ownerUserId });
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  return createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId: jobId,
  });
}

/** Responses handed out here, closed after each test: a streaming body nobody
 *  reads holds its storage handle open, exactly as a real client's disconnect
 *  would if the route did not tear it down. */
const served: Response[] = [];

async function call(trackId: string, headers?: Record<string, string>, query = '') {
  const request = new Request(`http://localhost/api/audio/${trackId}${query}`, { headers });
  const response = await GET(request, { params: Promise.resolve({ trackId }) });
  served.push(response);
  return response;
}

function headerValues(res: Response): string[] {
  const values: string[] = [];
  res.headers.forEach((v) => values.push(v));
  return values;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('audio-route-test');
  dataRoot = await mkdtemp(path.join(tmpdir(), 'liedmotif-audio-'));
  storage = localFsStorageProvider({ dataRoot });
  holder.db = testDb.db;
  holder.storage = storage;
});

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
  await rm(dataRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, GENERATION_FIXTURE_TABLES);
  holder.ownerUserId = null;
});

afterEach(async () => {
  for (const response of served.splice(0)) {
    if (!response.bodyUsed) await response.body?.cancel().catch(() => undefined);
  }
});

describe.skipIf(skip)('GET /api/audio/[trackId]', () => {
  it('streams the owner’s downloaded local-final audio (200 full body)', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const { trackId } = await seedOwnedTrackWithAudio(owner);

    const res = await call(trackId);
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(res.headers.get('content-length')).toBe('20');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(BODY)).toBe(true);
  });

  it('never serves a stored non-audio content type back inline', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    // A hostile or MITM'd provider response persisted as `text/html`: echoed
    // back, a top-level GET to this same-origin URL would execute it in the app
    // origin with the session cookie riding along under SameSite=Lax.
    const { trackId } = await seedOwnedTrackWithAudio(owner, 'text/html');

    const res = await call(trackId);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves a 206 partial response for a Range request', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const { trackId } = await seedOwnedTrackWithAudio(owner);

    const res = await call(trackId, { range: 'bytes=0-3' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-3/20');
    expect(res.headers.get('content-length')).toBe('4');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(BODY.subarray(0, 4))).toBe(true);
  });

  it('answers 416 for a range start too large to be a safe integer', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const { trackId } = await seedOwnedTrackWithAudio(owner);

    // The combined read+stat path would otherwise hand this start straight to
    // the adapter, which throws ERR_OUT_OF_RANGE before any bounds check.
    const res = await call(trackId, { range: 'bytes=99999999999999999999-' });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${BODY.length}`);
  });

  it('ignores an unsupported multi-range and returns the full body (200)', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const { trackId } = await seedOwnedTrackWithAudio(owner);

    const res = await call(trackId, { range: 'bytes=0-3,5-7' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('20');
  });

  it('returns 404 for a track owned by another user (no cross-owner access)', async () => {
    const owner = await createUser(testDb.db);
    const other = await createUser(testDb.db);
    holder.ownerUserId = owner; // caller is `owner`...
    const { trackId } = await seedOwnedTrackWithAudio(other); // ...but the track is `other`'s

    const res = await call(trackId);
    expect(res.status).toBe(404);
  });

  it('returns 404 when the local-final asset has not been downloaded yet', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const trackId = await seedOwnedTrackNoAudio(owner);

    const res = await call(trackId);
    expect(res.status).toBe(404);
  });

  it('returns 401 when not signed in as the owner', async () => {
    const owner = await createUser(testDb.db);
    const { trackId } = await seedOwnedTrackWithAudio(owner);
    holder.ownerUserId = null; // unauthenticated

    const res = await call(trackId);
    expect(res.status).toBe(401);
  });

  // Source-pinned serving: `?asset=` serves
  // EXACTLY that asset or 404s — never the ladder — so the client can infer the
  // committed source kind from which pinned URL succeeded.
  describe('source pinning (?asset=final|stream)', () => {
    it('?asset=final serves the downloaded local final', async () => {
      const owner = await createUser(testDb.db);
      holder.ownerUserId = owner;
      const { trackId } = await seedOwnedTrackWithAudio(owner);

      const res = await call(trackId, undefined, '?asset=final');
      expect(res.status).toBe(200);
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.equals(BODY)).toBe(true);
    });

    it('?asset=final 404s before the final is downloaded (no ladder fallback)', async () => {
      const owner = await createUser(testDb.db);
      holder.ownerUserId = owner;
      const trackId = await seedOwnedTrackNoAudio(owner);

      const res = await call(trackId, undefined, '?asset=final');
      expect(res.status).toBe(404);
    });

    it('?asset=stream 404s when no stream asset exists (e.g. evicted) — never the final', async () => {
      const owner = await createUser(testDb.db);
      holder.ownerUserId = owner;
      // The final exists, so an unpinned request would serve bytes — the pin must not.
      const { trackId } = await seedOwnedTrackWithAudio(owner);

      const res = await call(trackId, undefined, '?asset=stream');
      expect(res.status).toBe(404);
    });

    it('an unknown asset value is indistinguishable from a missing asset (404)', async () => {
      const owner = await createUser(testDb.db);
      holder.ownerUserId = owner;
      const { trackId } = await seedOwnedTrackWithAudio(owner);

      const res = await call(trackId, undefined, '?asset=bogus');
      expect(res.status).toBe(404);
    });

    it('pinned requests keep the auth posture (401 unauthenticated, 404 cross-owner)', async () => {
      const owner = await createUser(testDb.db);
      const other = await createUser(testDb.db);
      const { trackId } = await seedOwnedTrackWithAudio(other);

      holder.ownerUserId = null;
      expect((await call(trackId, undefined, '?asset=final')).status).toBe(401);
      holder.ownerUserId = owner;
      expect((await call(trackId, undefined, '?asset=final')).status).toBe(404);
    });

    it('pinned final supports Range like the unpinned path', async () => {
      const owner = await createUser(testDb.db);
      holder.ownerUserId = owner;
      const { trackId } = await seedOwnedTrackWithAudio(owner);

      const res = await call(trackId, { range: 'bytes=0-3' }, '?asset=final');
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe('bytes 0-3/20');
    });
  });

  // Weak validator on local finals: past the deliberate 1 h max-age, a replay
  // revalidates to a 304 instead of re-downloading the file. A retag rewrites
  // bytes under the same key, so the validator invalidates exactly when the
  // bytes change.
  describe('conditional requests (ETag / If-None-Match)', () => {
    it('emits a weak ETag and Last-Modified on full and Range responses', async () => {
      const owner = await createUser(testDb.db);
      holder.ownerUserId = owner;
      const { trackId } = await seedOwnedTrackWithAudio(owner);

      const full = await call(trackId);
      expect(full.headers.get('etag')).toMatch(/^W\/"\d+-\d+"$/);
      expect(full.headers.get('last-modified')).toBeTruthy();

      const ranged = await call(trackId, { range: 'bytes=0-3' });
      expect(ranged.headers.get('etag')).toBe(full.headers.get('etag'));
    });

    it('answers 304 with no body for a matching If-None-Match', async () => {
      const owner = await createUser(testDb.db);
      holder.ownerUserId = owner;
      const { trackId } = await seedOwnedTrackWithAudio(owner);

      const etag = (await call(trackId)).headers.get('etag')!;
      const res = await call(trackId, { 'if-none-match': etag });
      expect(res.status).toBe(304);
      expect(res.headers.get('etag')).toBe(etag);
      expect((await res.arrayBuffer()).byteLength).toBe(0);
    });

    it('serves the full body for a stale validator', async () => {
      const owner = await createUser(testDb.db);
      holder.ownerUserId = owner;
      const { trackId } = await seedOwnedTrackWithAudio(owner);

      const res = await call(trackId, { 'if-none-match': 'W/"999-12345"' });
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(BODY)).toBe(true);
    });

    it('invalidates the old validator when the bytes are rewritten under the same key (retag)', async () => {
      const owner = await createUser(testDb.db);
      holder.ownerUserId = owner;
      const { trackId, key } = await seedOwnedTrackWithAudio(owner);
      const oldEtag = (await call(trackId)).headers.get('etag')!;

      const retagged = Buffer.concat([BODY, Buffer.from('id3-frame')]);
      await storage.write({ key, body: retagged, mimeType: 'audio/mpeg' });

      const res = await call(trackId, { 'if-none-match': oldEtag });
      expect(res.status).toBe(200);
      expect(res.headers.get('etag')).not.toBe(oldEtag);
      expect(Buffer.from(await res.arrayBuffer()).equals(retagged)).toBe(true);
    });

    it('If-None-Match wins over Range: a matching validator is 304 even with a Range', async () => {
      const owner = await createUser(testDb.db);
      holder.ownerUserId = owner;
      const { trackId } = await seedOwnedTrackWithAudio(owner);

      const etag = (await call(trackId)).headers.get('etag')!;
      const res = await call(trackId, { 'if-none-match': etag, range: 'bytes=0-3' });
      expect(res.status).toBe(304);
      expect((await res.arrayBuffer()).byteLength).toBe(0);
    });

    it('a stale validator with a Range serves the 206 slice', async () => {
      const owner = await createUser(testDb.db);
      holder.ownerUserId = owner;
      const { trackId } = await seedOwnedTrackWithAudio(owner);

      const res = await call(trackId, { 'if-none-match': 'W/"999-12345"', range: 'bytes=0-3' });
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe('bytes 0-3/20');
    });
  });

  // A storage body that stops mid-file (S3 stalled behind an overloaded
  // endpoint or a half-open connection) must not hold the response open: a
  // silent hang reaches the player as audio that just stops, with no error to
  // step down on, and pins the storage socket until the far end gives up.
  describe('a local-final body that stops sending', () => {
    let source: PassThrough;

    async function serveStalledFinal(): Promise<ReadableStreamDefaultReader<Uint8Array>> {
      const owner = await createUser(testDb.db);
      holder.ownerUserId = owner;
      const { trackId } = await seedOwnedTrackWithAudio(owner);
      source = new PassThrough();
      source.write(Buffer.alloc(4096, 7));
      holder.storage = {
        readStreamWithStat: async () => ({
          stat: { byteSize: 100_000, updatedAt: new Date(), mimeType: 'audio/mpeg' },
          stream: source,
        }),
      };
      const res = await call(trackId, undefined, '?asset=final');
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      expect((await reader.read()).value?.byteLength).toBe(4096);
      return reader;
    }

    afterEach(() => {
      vi.useRealTimers();
      holder.storage = storage;
    });

    it('errors the response once no bytes arrive for the idle bound, releasing the source', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const reader = await serveStalledFinal();
      const next = reader.read();
      const outcome = expect(next).rejects.toThrow(/idle/);

      await vi.advanceTimersByTimeAsync(30_000);

      await outcome;
      expect(source.destroyed).toBe(true);
    });

    it('releases the source at once when the client cancels mid-stall', async () => {
      const reader = await serveStalledFinal();
      void reader.read().catch(() => undefined);

      await reader.cancel();

      expect(source.destroyed).toBe(true);
    });
  });

  it('never leaks the storage key or filesystem path in the response', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const { trackId, key } = await seedOwnedTrackWithAudio(owner);

    const res = await call(trackId);
    const values = headerValues(res);
    for (const v of values) {
      expect(v).not.toContain(key);
      expect(v).not.toContain(dataRoot);
      expect(v).not.toContain('tracks/');
    }
    // The body is the raw audio bytes, not a path.
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(BODY)).toBe(true);
  });
});
