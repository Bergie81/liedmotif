import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coverRenditionKey } from '@liedmotif/db';
import { COVER_THUMBNAIL_EDGE } from '@liedmotif/shared';

// The `?w=<edge>` tile path: warm requests stream the cached rendition without
// ever touching the original (one stat + one read); cold requests render it
// once — concurrent requests for the same cover share a single decode+write —
// and a render failure falls back to the original bytes. The full-size branch
// answers 404 (not 500) when the cover is reclaimed between stat and read.

const COVER_ID = '3f9a1c58-7b2d-4e6f-8a0b-1c2d3e4f5a6b';
const ORIGINAL_KEY = 'covers/original.webp';
const RENDITION_KEY = coverRenditionKey(COVER_ID);
const ORIGINAL_BYTES = Buffer.from('original-cover-bytes');
const RENDITION_BYTES = Buffer.from('rendition-bytes');

const storage = {
  objects: new Map<string, Buffer>(),
  writes: [] as string[],
  deletes: [] as string[],
  statCalls: [] as string[],
  failReadOf: null as string | null,
  async stat(key: string) {
    this.statCalls.push(key);
    const bytes = this.objects.get(key);
    return bytes ? { byteSize: bytes.byteLength, mimeType: 'image/webp' } : null;
  },
  async readStream(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes || this.failReadOf === key) throw new Error('missing');
    return Readable.from([bytes]);
  },
  async write({ key, body }: { key: string; body: Buffer }) {
    this.writes.push(key);
    this.objects.set(key, Buffer.from(body));
  },
  async delete(key: string) {
    this.deletes.push(key);
    this.objects.delete(key);
  },
};

const render = vi.hoisted(() => ({
  gate: null as Promise<void> | null,
  fail: false,
  calls: 0,
  /** Runs inside the decode — where the orphan sweep can land on this cover. */
  during: null as null | (() => void),
}));

/** Whether the cover row still exists, so a test can reclaim it mid-render. */
const rows = vi.hoisted(() => ({ coverExists: true }));

vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => ({ user: { id: 'admin' } }),
  getAppSession: async () => ({ user: { id: 'admin' } }),
}));
vi.mock('@liedmotif/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@liedmotif/db')>();
  return {
    ...actual,
    getCoverImageById: async (_db: unknown, id: string) =>
      id === COVER_ID && rows.coverExists
        ? {
            id,
            sourceType: 'generated',
            storageKey: ORIGINAL_KEY,
            provenance: { ownerUserId: 'admin' },
          }
        : null,
  };
});
vi.mock('@liedmotif/media', () => ({
  renderCoverThumbnail: async () => {
    render.calls += 1;
    render.during?.();
    if (render.gate) await render.gate;
    if (render.fail) throw new Error('decode failed');
    return RENDITION_BYTES;
  },
}));
vi.mock('@/lib/providers', () => ({ getStorageProvider: () => storage }));

// The single-flight map is module state, so each test starts from a fresh route module.
async function call(query = `?w=${COVER_THUMBNAIL_EDGE}`) {
  const { GET } = await import('@/app/api/covers/[id]/route');
  return GET(new Request(`http://localhost/api/covers/${COVER_ID}${query}`), {
    params: Promise.resolve({ id: COVER_ID }),
  });
}

beforeEach(() => {
  vi.resetModules();
  storage.objects.clear();
  storage.objects.set(ORIGINAL_KEY, ORIGINAL_BYTES);
  storage.writes = [];
  storage.deletes = [];
  storage.statCalls = [];
  storage.failReadOf = null;
  render.gate = null;
  render.fail = false;
  render.calls = 0;
  render.during = null;
  rows.coverExists = true;
});

describe('GET /api/covers/[id]?w — tile rendition', () => {
  it('streams the cached rendition without stating the original (warm path)', async () => {
    storage.objects.set(RENDITION_KEY, RENDITION_BYTES);
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/webp');
    expect(res.headers.get('Content-Length')).toBe(String(RENDITION_BYTES.byteLength));
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(RENDITION_BYTES);
    expect(render.calls).toBe(0);
    expect(storage.statCalls).not.toContain(ORIGINAL_KEY);
  });

  it('renders, caches, and serves the rendition on the cold path', async () => {
    const cold = await call();
    expect(cold.status).toBe(200);
    expect(Buffer.from(await cold.arrayBuffer())).toEqual(RENDITION_BYTES);
    expect(storage.writes).toEqual([RENDITION_KEY]);

    const warm = await call();
    expect(Buffer.from(await warm.arrayBuffer())).toEqual(RENDITION_BYTES);
    expect(render.calls).toBe(1);
    expect(storage.writes).toEqual([RENDITION_KEY]);
  });

  it('unlinks the rendition it just wrote when the cover was reclaimed mid-render', async () => {
    // The orphan sweep nominates covers by ROW, so a rendition written after its
    // row is gone would be invisible to every future sweep.
    render.during = () => {
      rows.coverExists = false;
    };

    const res = await call();

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(RENDITION_BYTES);
    expect(storage.writes).toEqual([RENDITION_KEY]);
    expect(storage.deletes).toEqual([RENDITION_KEY]);
    expect(storage.objects.has(RENDITION_KEY)).toBe(false);
  });

  it('shares one render+write across concurrent cold requests', async () => {
    let open!: () => void;
    render.gate = new Promise((resolve) => (open = resolve));
    const requests = [call(), call(), call()];
    // Let every request reach the render before it is allowed to finish.
    await new Promise((resolve) => setTimeout(resolve, 10));
    open();
    const responses = await Promise.all(requests);
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(RENDITION_BYTES);
    }
    expect(render.calls).toBe(1);
    expect(storage.writes).toEqual([RENDITION_KEY]);
  });

  it('falls back to the original bytes when the render fails', async () => {
    render.fail = true;
    const res = await call();
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(ORIGINAL_BYTES);
    expect(storage.writes).toEqual([]);
  });
});

describe('GET /api/covers/[id] — full-size branch', () => {
  it('serves the original bytes unchanged', async () => {
    const res = await call('');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe(String(ORIGINAL_BYTES.byteLength));
    expect(Buffer.from(await res.arrayBuffer())).toEqual(ORIGINAL_BYTES);
  });

  it('answers 404 when the cover is reclaimed between stat and read', async () => {
    storage.failReadOf = ORIGINAL_KEY;
    const res = await call('');
    expect(res.status).toBe(404);
  });
});
