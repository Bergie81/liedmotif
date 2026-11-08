import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectTestDb,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { getCoverArtSettings, updateCoverArtSettings } from '@liedmotif/db';
import { MAX_COVER_STYLE_HINT_LENGTH } from '@liedmotif/shared';

// POST /api/settings/cover-art: the admin saves the Custom cover style definition
// (Settings → Cover Arts). The definition is a bounded style HINT for the cover
// pipeline — trimmed, length-capped, admin-only; an empty save clears it (which
// makes the create card's `Custom` choice fall back to `auto`).

const holder = vi.hoisted(() => ({ db: null as unknown, admin: false }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.admin ? { user: { id: 'admin-1' } } : null),
  getAppSession: async () => (holder.admin ? { user: { id: 'admin-1' } } : null),
}));
vi.mock('@/lib/providers', () => ({ getLlmProvider: async () => null }));

const { POST: coverArtPost } = await import('@/app/api/settings/cover-art/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function postJson(body: unknown) {
  return coverArtPost(
    new Request('http://localhost/api/settings/cover-art', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('settings-cover-art-route-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  holder.admin = true;
  await truncateTables(testDb.pool, ['app_settings']);
  await updateCoverArtSettings(testDb.db, {
    defaultStyle: 'photographic',
    customStyleDefinition: 'previous definition',
  });
});

describe.skipIf(skip)('POST /api/settings/cover-art', () => {
  it('rejects the request without an admin session', async () => {
    holder.admin = false;
    const res = await postJson({ customStyleDefinition: 'bold comic ink' });
    expect(res.status).toBe(401);
    expect((await getCoverArtSettings(testDb.db)).customStyleDefinition).toBe(
      'previous definition',
    );
  });

  it('saves the trimmed definition and allows an empty save to clear it', async () => {
    const ok = await postJson({ customStyleDefinition: '  Bold comic-book cover art.  ' });
    expect(ok.status).toBe(200);
    expect((await getCoverArtSettings(testDb.db)).customStyleDefinition).toBe(
      'Bold comic-book cover art.',
    );

    const cleared = await postJson({ customStyleDefinition: '   ' });
    expect(cleared.status).toBe(200);
    expect((await getCoverArtSettings(testDb.db)).customStyleDefinition).toBe('');
  });

  it('saves the default cover style without touching the stored definition', async () => {
    const res = await postJson({ defaultStyle: 'custom' });
    expect(res.status).toBe(200);

    const settings = await getCoverArtSettings(testDb.db);
    expect(settings.defaultStyle).toBe('custom');
    expect(settings.customStyleDefinition).toBe('previous definition');
  });

  it.each([
    ['an empty body', {}],
    ['a non-string definition', { customStyleDefinition: 42 }],
    [
      'an over-long definition',
      { customStyleDefinition: 'x'.repeat(MAX_COVER_STYLE_HINT_LENGTH + 1) },
    ],
    ['an unknown default style', { defaultStyle: 'neon' }],
    ['a non-string default style', { defaultStyle: 7 }],
    ['a top-level array', []],
    ['a top-level null', null],
  ])('rejects %s without changing the stored settings', async (_label, body) => {
    const res = await postJson(body);
    expect(res.status).toBe(400);
    const settings = await getCoverArtSettings(testDb.db);
    expect(settings.defaultStyle).toBe('photographic');
    expect(settings.customStyleDefinition).toBe('previous definition');
  });
});
