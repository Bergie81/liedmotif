import { describe, expect, it, vi } from 'vitest';

// Cover id validation: a malformed path segment must 404 like a
// missing cover, BEFORE the uuid-typed DB query (which would 500). No database —
// the db mock throws if the guard ever lets a bad id through.

const holder = vi.hoisted(() => ({ authed: true }));
vi.mock('@/lib/db', () => ({
  getDb: () => {
    throw new Error('DB must not be touched for a malformed id');
  },
}));
vi.mock('@/lib/providers', () => ({ getStorageProvider: () => ({}) }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.authed ? { user: { id: 'admin' } } : null),
  getAppSession: async () => (holder.authed ? { user: { id: 'admin' } } : null),
}));

const { GET } = await import('@/app/api/covers/[id]/route');

function call(id: string) {
  return GET(new Request(`http://localhost/api/covers/${id}`), {
    params: Promise.resolve({ id }),
  });
}

describe('GET /api/covers/[id] — id validation', () => {
  it('returns 404 for a malformed id without touching the DB', async () => {
    for (const id of ['not-a-uuid', '123', "1'; drop table cover_images;--"]) {
      const res = await call(id);
      expect(res.status).toBe(404);
    }
  });

  it('still requires the admin session first (401 before any id handling)', async () => {
    holder.authed = false;
    expect((await call('not-a-uuid')).status).toBe(401);
    holder.authed = true;
  });
});
