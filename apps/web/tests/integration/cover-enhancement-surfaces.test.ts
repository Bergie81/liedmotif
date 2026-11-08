import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectTestDb,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { getCoverArtSettings, updateCoverArtSettings } from '@liedmotif/db';

// The Settings → Cover Arts custom-style enhance-on-save surface (decision D4).

const holder = vi.hoisted(() => ({
  db: null as unknown,
  ownerUserId: null as string | null,
  llm: null as null | {
    enhanceCoverDirection: (input: {
      text: string;
      context: Record<string, unknown>;
    }) => Promise<{ text: string; applied: boolean }>;
  },
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
vi.mock('@/lib/providers', () => ({
  getLlmProvider: async () => holder.llm,
  getStorageProvider: () => ({ providerKey: 'local-fs' }),
}));

const { POST: coverArtSettingsPost } = await import('@/app/api/settings/cover-art/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function postJson(handler: (r: Request) => Promise<Response>, body: unknown) {
  return handler(
    new Request('http://localhost/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('cover-enhancement-surfaces-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, [...GENERATION_FIXTURE_TABLES, 'app_settings']);
  holder.ownerUserId = null;
  holder.llm = null;
});

describe.skipIf(skip)('Settings → Cover Arts enhance-on-save (D4)', () => {
  it('rewrites a changed custom definition through the LLM and stores the enhanced text', async () => {
    holder.ownerUserId = await createUser(testDb.db);
    holder.llm = {
      enhanceCoverDirection: async (input) => ({ text: `ENHANCED ${input.text}`, applied: true }),
    };

    const response = await postJson(coverArtSettingsPost, {
      defaultStyle: 'custom',
      customStyleDefinition: 'torn paper collage',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      settings: { customStyleDefinition: string };
      enhancement: { attempted: boolean; applied: boolean };
    };
    expect(body.enhancement).toEqual({ attempted: true, applied: true });
    // Visible write-back: what is stored is exactly what the user sees.
    expect(body.settings.customStyleDefinition).toBe('ENHANCED torn paper collage');
    expect((await getCoverArtSettings(testDb.db)).customStyleDefinition).toBe(
      'ENHANCED torn paper collage',
    );
  });

  it('keeps and saves the raw definition when enhancement fails, reporting it', async () => {
    holder.ownerUserId = await createUser(testDb.db);
    holder.llm = {
      enhanceCoverDirection: async (input) => ({ text: input.text, applied: false }),
    };

    const response = await postJson(coverArtSettingsPost, {
      customStyleDefinition: 'torn paper collage',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      settings: { customStyleDefinition: string };
      enhancement: { attempted: boolean; applied: boolean };
    };
    expect(body.enhancement).toEqual({ attempted: true, applied: false });
    expect(body.settings.customStyleDefinition).toBe('torn paper collage');
  });

  it('saves without any LLM call when enhancement is off or no LLM is configured', async () => {
    holder.ownerUserId = await createUser(testDb.db);
    let calls = 0;
    holder.llm = {
      enhanceCoverDirection: async (input) => {
        calls += 1;
        return { text: `ENHANCED ${input.text}`, applied: true };
      },
    };
    await updateCoverArtSettings(testDb.db, { promptEnhancementEnabled: false });

    const offResponse = await postJson(coverArtSettingsPost, {
      customStyleDefinition: 'torn paper collage',
    });
    const offBody = (await offResponse.json()) as {
      settings: { customStyleDefinition: string };
      enhancement: { attempted: boolean };
    };
    expect(calls).toBe(0);
    expect(offBody.enhancement.attempted).toBe(false);
    expect(offBody.settings.customStyleDefinition).toBe('torn paper collage');

    // An unchanged definition is never re-enhanced (no drift on repeated saves).
    await updateCoverArtSettings(testDb.db, { promptEnhancementEnabled: true });
    const unchanged = await postJson(coverArtSettingsPost, {
      customStyleDefinition: 'torn paper collage',
    });
    expect(
      ((await unchanged.json()) as { enhancement: { attempted: boolean } }).enhancement,
    ).toEqual({ attempted: false, applied: false });
    expect(calls).toBe(0);
  });
});
