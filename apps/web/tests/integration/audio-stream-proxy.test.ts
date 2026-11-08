import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeEncryptionKey, upsertProviderTrackWithAssets } from '@liedmotif/db';
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

// Cold-start LAYER 2: the audio route proxies a track's provider stream
// server-side when the local final has not downloaded yet. The provider/signed URL is
// decrypted in-process and never reaches the client; the client's Range is forwarded.
// A cross-owner track stays indistinguishable from missing (404).

// A real base64 32-byte key. The route's `encryptionKeyIfConfigured` reads it from the
// env at request time (set in beforeAll, restored in afterAll so it never leaks to
// other suites); the same key encrypts the staged provider_stream asset.
const KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7) % 256)).toString('base64');
const KEY = decodeEncryptionKey(KEY_B64);
let priorKeyEnv: string | undefined;

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
// Provider media is fetched through undici directly (the egress guard pins the
// connection to the vetted addresses via a dispatcher, which a framework-wrapped
// global `fetch` could silently drop) — so the transport stub belongs here.
const { fetchStub } = vi.hoisted(() => ({ fetchStub: vi.fn() }));
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: fetchStub,
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/providers', () => ({ getStorageProvider: () => ({}) }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
// The egress guard resolves upstream hostnames before fetching; pin the fixture
// host to a public address so no test ever touches real DNS.
vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));

const { GET } = await import('@/app/api/audio/[trackId]/route');

const skip = !TEST_DATABASE_URL;
const STREAM_URL = 'https://stream.example/track-A?sig=secret-token';
const BYTES = Buffer.from(Array.from({ length: 40 }, (_, i) => (i * 3) % 256));
let testDb: TestDb;

/** Serves BYTES, honoring a forwarded Range with a 206. Zero network. */
const serveBytes = async (_url: string, init?: RequestInit) => {
  const range = (init?.headers as Record<string, string> | undefined)?.Range;
  if (range) {
    const m = /^bytes=(\d+)-(\d+)?$/.exec(range)!;
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : BYTES.length - 1;
    const slice = BYTES.subarray(start, end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        'content-type': 'audio/mpeg',
        'accept-ranges': 'bytes',
        'content-length': String(slice.length),
        'content-range': `bytes ${start}-${end}/${BYTES.length}`,
      },
    });
  }
  return new Response(BYTES, {
    status: 200,
    headers: {
      'content-type': 'audio/mpeg',
      'accept-ranges': 'bytes',
      'content-length': String(BYTES.length),
    },
  });
};

async function seedStreamOnlyTrack(ownerUserId: string, streamUrl = STREAM_URL): Promise<string> {
  const sessionId = await createSession(testDb.db, { ownerUserId });
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  const r = await upsertProviderTrackWithAssets(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId: jobId,
    activitySessionId: sessionId,
    providerKey: 'mock',
    prompt: 'instrumental lofi',
    encryptionKey: KEY,
    track: { providerTrackId: 'A', streamAudioUrl: streamUrl },
  });
  return r.trackId;
}

function call(trackId: string, headers?: Record<string, string>, query = '') {
  const request = new Request(`http://localhost/api/audio/${trackId}${query}`, { headers });
  return GET(request, { params: Promise.resolve({ trackId }) });
}

beforeAll(async () => {
  if (skip) return;
  priorKeyEnv = process.env.CREDENTIAL_ENCRYPTION_KEY;
  process.env.CREDENTIAL_ENCRYPTION_KEY = KEY_B64;
  testDb = await connectTestDb('audio-stream-proxy-test');
  holder.db = testDb.db;
  fetchStub.mockImplementation(serveBytes);
});
afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
  vi.unstubAllGlobals();
  if (priorKeyEnv === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  else process.env.CREDENTIAL_ENCRYPTION_KEY = priorKeyEnv;
});
beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, GENERATION_FIXTURE_TABLES);
  holder.ownerUserId = null;
  fetchStub.mockReset();
  fetchStub.mockImplementation(serveBytes);
});
afterEach(() => {
  if (skip) return;
});

describe.skipIf(skip)('GET /api/audio/[trackId] — provider stream proxy', () => {
  it('proxies the decrypted provider stream as a 200 full body', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const trackId = await seedStreamOnlyTrack(owner);

    const res = await call(trackId);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(BYTES)).toBe(true);

    // The route fetched the DECRYPTED provider URL server-side, through a
    // dispatcher pinned to the addresses the egress guard vetted.
    expect(fetchStub).toHaveBeenCalledWith(STREAM_URL, expect.anything());
    expect((fetchStub.mock.calls[0]![1] as { dispatcher?: unknown }).dispatcher).toBeDefined();
  });

  it('forwards a Range header and mirrors the provider 206', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const trackId = await seedStreamOnlyTrack(owner);

    const res = await call(trackId, { range: 'bytes=0-9' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-9/${BYTES.length}`);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(BYTES.subarray(0, 10))).toBe(true);
    // The Range was forwarded to the provider.
    const init = fetchStub.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Range).toBe('bytes=0-9');
  });

  it('never echoes a non-audio provider content type', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const trackId = await seedStreamOnlyTrack(owner);

    // A hostile or MITM'd provider answering with markup: echoed back, a
    // top-level GET to this same-origin URL would execute it in the app origin.
    fetchStub.mockImplementationOnce(
      async () =>
        new Response('<script>alert(1)</script>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );

    const res = await call(trackId);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('does NOT forward upstream Content-Length when the body was content-encoded', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const trackId = await seedStreamOnlyTrack(owner);

    // fetch decompresses the body transparently while `content-length` still
    // reports the COMPRESSED size; forwarding it would truncate playback.
    fetchStub.mockImplementationOnce(
      async () =>
        new Response(BYTES, {
          status: 200,
          headers: {
            'content-type': 'audio/mpeg',
            'content-encoding': 'gzip',
            'content-length': '10', // the (stale) compressed size — NOT the body length
          },
        }),
    );

    const res = await call(trackId);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBeNull();
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(BYTES)).toBe(true);
  });

  it('maps an upstream 416 through as 416 with Content-Range (not 502)', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const trackId = await seedStreamOnlyTrack(owner);

    fetchStub.mockImplementationOnce(
      async () =>
        new Response(null, {
          status: 416,
          headers: { 'content-range': `bytes */${BYTES.length}` },
        }),
    );

    const res = await call(trackId, { range: `bytes=${BYTES.length + 100}-` });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${BYTES.length}`);
  });

  // Source-pinned serving on the stream side.
  it('?asset=stream proxies the provider stream exactly like the unpinned layer-2 path', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const trackId = await seedStreamOnlyTrack(owner);

    const res = await call(trackId, undefined, '?asset=stream');
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(BYTES)).toBe(true);
  });

  it('?asset=final 404s on a stream-only track without touching the provider', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const trackId = await seedStreamOnlyTrack(owner);

    const res = await call(trackId, undefined, '?asset=final');
    expect(res.status).toBe(404);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('never leaks the provider/signed URL in any response header', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const trackId = await seedStreamOnlyTrack(owner);

    const res = await call(trackId);
    const values: string[] = [];
    res.headers.forEach((v) => values.push(v));
    for (const v of values) {
      expect(v).not.toContain('stream.example');
      expect(v).not.toContain('secret-token');
    }
  });

  it('cancels a non-OK upstream body instead of leaving the connection dangling', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const trackId = await seedStreamOnlyTrack(owner);

    // A broken/hostile provider answers 500 and then trickles an endless error
    // body — the proxy must tear it down, not just answer 502 and move on.
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    fetchStub.mockImplementationOnce(async () => new Response(endless, { status: 500 }));

    const res = await call(trackId);
    expect(res.status).toBe(502);
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it('blocks a provider stream URL pointing at a private/metadata host (502, no fetch)', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const trackId = await seedStreamOnlyTrack(owner, 'http://169.254.169.254/latest/meta-data');

    const res = await call(trackId);
    expect(res.status).toBe(502);
    // The egress guard refused BEFORE any network I/O.
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('follows an upstream redirect to a public host, but refuses one to a private host', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;

    // Public redirect target: followed (manually), bytes flow.
    const publicTrack = await seedStreamOnlyTrack(owner);
    fetchStub.mockImplementationOnce(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example/moved/track-A' },
        }),
    );
    const followed = await call(publicTrack);
    expect(followed.status).toBe(200);
    expect(Buffer.from(await followed.arrayBuffer()).equals(BYTES)).toBe(true);
    expect(fetchStub).toHaveBeenLastCalledWith(
      'https://cdn.example/moved/track-A',
      expect.anything(),
    );

    // Private redirect target: refused without fetching it.
    fetchStub.mockClear();
    fetchStub.mockImplementationOnce(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://192.168.1.10/internal' },
        }),
    );
    const refused = await call(publicTrack);
    expect(refused.status).toBe(502);
    expect(fetchStub).toHaveBeenCalledTimes(1); // only the first (public) hop
  });

  it('returns 404 for a malformed track id without touching the DB', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const res = await call('not-a-uuid');
    expect(res.status).toBe(404);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('returns 404 for a stream-only track owned by another user (no cross-owner access)', async () => {
    const owner = await createUser(testDb.db);
    const other = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const trackId = await seedStreamOnlyTrack(other);

    const res = await call(trackId);
    expect(res.status).toBe(404);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('returns 401 when not signed in', async () => {
    const owner = await createUser(testDb.db);
    const trackId = await seedStreamOnlyTrack(owner);
    holder.ownerUserId = null;
    const res = await call(trackId);
    expect(res.status).toBe(401);
  });
});
