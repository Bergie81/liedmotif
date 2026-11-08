import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLACEHOLDER_COVER_ID } from '@liedmotif/db';

// The reserved `placeholder` segment lets the browser reference the built-in
// placeholder cover without its uuid, which lives in the server-only
// `@liedmotif/db` package a client bundle cannot import. The route also self-heals
// the placeholder: a missing row or missing bytes (an instance whose DB/volume
// predates it) is re-provisioned on first serve instead of 404ing into the UI's
// icon fallback — once per process, so an unfixable asset is not retried per
// request.

const PLACEHOLDER_BYTES = Buffer.from('placeholder-webp-bytes');

/** A generated cover whose provenance names an owner (cross-owner fixtures). */
const OWNED_COVER_ID = '7b8d4c62-1a5e-4f3b-9c0d-2e6f8a917354';

const state = {
  rowPresent: true,
  bytesPresent: true,
  healable: true,
  sessionUserId: 'admin',
};
const ensurePlaceholderCover = vi.fn(async () => {
  if (!state.healable) throw new Error('asset unreadable');
  state.rowPresent = true;
  state.bytesPresent = true;
  return 'written' as const;
});

vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => ({ user: { id: state.sessionUserId } }),
  getAppSession: async () => ({ user: { id: state.sessionUserId } }),
}));
vi.mock('@liedmotif/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@liedmotif/db')>();
  return {
    ...actual,
    // Nothing here is In Lounge: the refusal path consults the Lounge
    // read widening and must still land on the uniform 404.
    isCoverLoungeVisible: async () => false,
    getCoverImageById: async (_db: unknown, id: string) => {
      if (id === OWNED_COVER_ID) {
        return {
          id,
          sourceType: 'generated',
          storageKey: actual.PLACEHOLDER_COVER_STORAGE_KEY,
          provenance: { ownerUserId: 'owner-1' },
        };
      }
      return state.rowPresent && id === actual.PLACEHOLDER_COVER_ID
        ? {
            id,
            sourceType: 'placeholder',
            storageKey: actual.PLACEHOLDER_COVER_STORAGE_KEY,
            provenance: null,
          }
        : null;
    },
  };
});
vi.mock('@liedmotif/db/seed', () => ({ ensurePlaceholderCover }));
vi.mock('@/lib/providers', () => ({
  getStorageProvider: () => ({
    stat: async () =>
      state.bytesPresent
        ? { byteSize: PLACEHOLDER_BYTES.byteLength, mimeType: 'image/webp' }
        : null,
    readStream: async () => Readable.from([PLACEHOLDER_BYTES]),
  }),
}));

// The heal latch is module state, so each test starts from a fresh route module.
async function call(id: string) {
  const { GET } = await import('@/app/api/covers/[id]/route');
  return GET(new Request(`http://localhost/api/covers/${id}`), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.resetModules();
  state.rowPresent = true;
  state.bytesPresent = true;
  state.healable = true;
  state.sessionUserId = 'admin';
  ensurePlaceholderCover.mockClear();
});

describe('GET /api/covers/placeholder — reserved placeholder segment', () => {
  it('serves the built-in placeholder cover bytes', async () => {
    const res = await call('placeholder');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/webp');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PLACEHOLDER_BYTES);
    expect(ensurePlaceholderCover).not.toHaveBeenCalled();
  });

  it('serves a cover referenced by its explicit uuid', async () => {
    const res = await call(PLACEHOLDER_COVER_ID);
    expect(res.status).toBe(200);
  });

  it('returns 404 for other non-uuid segments', async () => {
    expect((await call('not-a-uuid')).status).toBe(404);
  });

  it('self-heals a missing placeholder row before serving', async () => {
    state.rowPresent = false;
    const res = await call('placeholder');
    expect(res.status).toBe(200);
    expect(ensurePlaceholderCover).toHaveBeenCalledTimes(1);
  });

  it('self-heals missing placeholder bytes before serving', async () => {
    state.bytesPresent = false;
    const res = await call('placeholder');
    expect(res.status).toBe(200);
    expect(ensurePlaceholderCover).toHaveBeenCalledTimes(1);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PLACEHOLDER_BYTES);
  });

  it('404s without retrying the heal once it has failed in this process', async () => {
    state.bytesPresent = false;
    state.healable = false;

    expect((await call('placeholder')).status).toBe(404);
    expect((await call('placeholder')).status).toBe(404);
    expect(ensurePlaceholderCover).toHaveBeenCalledTimes(1);
  });

  it('never heals a cover that is not the placeholder', async () => {
    state.rowPresent = false;
    expect((await call('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect(ensurePlaceholderCover).not.toHaveBeenCalled();
  });

  it('serves an owner-attributed cover to its owner alone — non-owners get the not-found shape', async () => {
    state.sessionUserId = 'owner-1';
    expect((await call(OWNED_COVER_ID)).status).toBe(200);

    // Any other signed-in user — a Member or the Admin alike (no admin
    // override) — sees the same 404 as a missing cover, never a
    // distinguishable 403.
    state.sessionUserId = 'member-2';
    expect((await call(OWNED_COVER_ID)).status).toBe(404);
    state.sessionUserId = 'admin';
    expect((await call(OWNED_COVER_ID)).status).toBe(404);
  });

  it('keeps the ownerless placeholder instance-global for every signed-in user', async () => {
    state.sessionUserId = 'member-2';
    expect((await call('placeholder')).status).toBe(200);
  });
});
