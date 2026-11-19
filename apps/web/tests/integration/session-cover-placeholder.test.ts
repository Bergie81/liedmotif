import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectTestDb,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import {
  coverImages,
  decodeEncryptionKey,
  PLACEHOLDER_COVER_ID,
  upsertProviderCredential,
} from '@liedmotif/db';
import { eq } from 'drizzle-orm';
import {
  generatedCoverModel,
  generatedCoverProviderConfigured,
  initialSessionCoverId,
  sunoCoverFallbackConfigured,
} from '@/lib/covers/covers';

// Start Session's initial Session Cover: always the built-in branded
// placeholder. The async generated cover (image model, else the music
// provider's own art) replaces it when it lands; when no generated cover ever
// arrives, the placeholder simply stays.

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

vi.mock('@/lib/db', () => ({ getDb: () => testDb.db }));

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('session-cover-placeholder-test');
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, ['cover_images', 'app_settings', 'provider_credentials']);
});

describe.skipIf(skip)('the initial Session Cover decision', () => {
  it('returns the placeholder cover', async () => {
    expect(await initialSessionCoverId(testDb.db)).toBe(PLACEHOLDER_COVER_ID);
  });

  it('seeds the placeholder row so the session FK never dangles', async () => {
    // An instance whose DB predates the placeholder cover (setup/db:seed not
    // re-run) must not point sessions at a missing row.
    await initialSessionCoverId(testDb.db);

    const rows = await testDb.db
      .select()
      .from(coverImages)
      .where(eq(coverImages.id, PLACEHOLDER_COVER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceType).toBe('placeholder');
  });

  it('is idempotent against an already-seeded placeholder row', async () => {
    await initialSessionCoverId(testDb.db);
    expect(await initialSessionCoverId(testDb.db)).toBe(PLACEHOLDER_COVER_ID);

    const rows = await testDb.db
      .select()
      .from(coverImages)
      .where(eq(coverImages.id, PLACEHOLDER_COVER_ID));
    expect(rows).toHaveLength(1);
  });
});

describe.skipIf(skip)('generatedCoverProviderConfigured', () => {
  const KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');
  const configured = (vars: Record<string, string>) =>
    generatedCoverProviderConfigured(vars as NodeJS.ProcessEnv);

  beforeEach(() => vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', KEY_BASE64));
  afterEach(() => vi.unstubAllEnvs());

  it('mirrors the worker: Covers are painted once an image key is saved in the app', async () => {
    expect(await configured({})).toBe(false);

    await upsertProviderCredential(testDb.db, {
      providerType: 'image',
      providerKey: 'openrouter',
      displayName: 'OpenRouter',
      secret: 'sk-or-saved-in-onboarding',
      encryptionKey: decodeEncryptionKey(KEY_BASE64),
    });
    expect(await configured({})).toBe(true);
  });

  it('counts an env key only while IMAGE_PROVIDER names its provider', async () => {
    expect(await configured({ IMAGE_PROVIDER: 'openrouter', IMAGE_API_KEY: 'k' })).toBe(true);
    expect(await configured({ IMAGE_PROVIDER: 'openrouter' })).toBe(false);
    expect(await configured({ IMAGE_API_KEY: 'k' })).toBe(false);
  });

  it('treats an unknown provider as not configured', async () => {
    // An unknown key fails the worker at boot — no generated cover is coming.
    expect(await configured({ IMAGE_PROVIDER: 'dall-e', IMAGE_API_KEY: 'k' })).toBe(false);
  });
});

describe.skipIf(skip)('generatedCoverModel', () => {
  const model = (vars: Record<string, string>) => generatedCoverModel(vars as NodeJS.ProcessEnv);

  it("names the selected provider's default model when none is set", async () => {
    expect(await model({ IMAGE_PROVIDER: 'openai', IMAGE_API_KEY: 'k' })).toBe(
      'gpt-image-2.6-flare',
    );
    expect(await model({ IMAGE_PROVIDER: 'gemini', IMAGE_API_KEY: 'k' })).toBe(
      'gemini-nano-banana-2.1',
    );
    expect(await model({ IMAGE_PROVIDER: 'openrouter', IMAGE_API_KEY: 'k' })).toBe(
      'google/gemini-3.1-flash-image',
    );
  });

  it('names the model IMAGE_MODEL sets', async () => {
    expect(
      await model({
        IMAGE_PROVIDER: 'openai',
        IMAGE_API_KEY: 'k',
        IMAGE_MODEL: 'gpt-image-2.5-flare',
      }),
    ).toBe('gpt-image-2.5-flare');
  });
});

describe.skipIf(skip)('sunoCoverFallbackConfigured', () => {
  const KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');

  beforeEach(() => {
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', KEY_BASE64);
    vi.stubEnv('SUNO_API_KEY', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('mirrors the worker: Suno draws Covers once a key is saved in the app', async () => {
    vi.stubEnv('MUSIC_PROVIDER', 'suno');
    expect(await sunoCoverFallbackConfigured()).toBe(false);

    await upsertProviderCredential(testDb.db, {
      providerType: 'music',
      providerKey: 'suno',
      displayName: 'Suno-compatible',
      secret: 'sk-saved-in-onboarding',
      encryptionKey: decodeEncryptionKey(KEY_BASE64),
    });
    expect(await sunoCoverFallbackConfigured()).toBe(true);
  });

  it('counts an env key too', async () => {
    vi.stubEnv('MUSIC_PROVIDER', 'suno');
    vi.stubEnv('SUNO_API_KEY', 'sk-env');
    expect(await sunoCoverFallbackConfigured()).toBe(true);
  });

  it('needs the Suno selection', async () => {
    vi.stubEnv('MUSIC_PROVIDER', 'mock');
    vi.stubEnv('SUNO_API_KEY', 'sk-env');
    expect(await sunoCoverFallbackConfigured()).toBe(false);
  });
});
