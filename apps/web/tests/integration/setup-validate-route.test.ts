import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectTestDb,
  truncateTables,
  TEST_DATABASE_URL,
  type TestDb,
} from '@liedmotif/db/testing';
import { upsertProviderCredential } from '@liedmotif/db';

// POST /api/setup/validate: Test must verify the credential GENERATION will
// actually use. When the form sends no secret/base URL, the route falls back to
// the resolved configuration — env first, then the stored row — instead of
// reporting `misconfigured` for a perfectly configured provider. An explicit
// body secret still wins (the wizard's type-before-save flow), and the SSRF
// guard applies to the RESOLVED base URL, not just the typed one.

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => ({ user: { id: 'admin-1' } }),
  getAppSession: async () => ({ user: { id: 'admin-1' } }),
}));
// The route is rate-limited per IP; the limiter is irrelevant to these behaviors.
vi.mock('@/lib/http/request-limits', () => ({
  validateLimiter: { check: () => ({ allowed: true, retryAfterMs: 0 }) },
}));

const { POST: validatePost } = await import('@/app/api/setup/validate/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

const ENCRYPTION_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const ENCRYPTION_KEY = Buffer.from(ENCRYPTION_KEY_B64, 'base64');

function postJson(body: unknown) {
  return validatePost(
    new Request('http://localhost/api/setup/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** Captured outbound probe calls — the stub never touches the network. */
let probeCalls: Array<{ url: string; authorization?: string }> = [];

function stubProbeFetch(status = 200, body: unknown = { code: 200, msg: 'success', data: 42 }) {
  probeCalls = [];
  vi.stubGlobal('fetch', async (url: URL | RequestInfo, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    probeCalls.push({ url: String(url), authorization: headers.authorization });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('setup-validate-route-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, ['provider_credentials']);
  // Deterministic env: blank out every var the route consults (the developer's
  // real .env must not leak into these assertions), then set the AES key so
  // stored secrets are storable/decryptable.
  for (const name of [
    'SUNO_API_KEY',
    'SUNO_BASE_URL',
    'LLM_PROVIDER',
    'LLM_API_KEY',
    'LLM_BASE_URL',
    'LLM_MODEL',
    'IMAGE_PROVIDER',
    'IMAGE_API_KEY',
    'IMAGE_MODEL',
  ]) {
    vi.stubEnv(name, '');
  }
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', ENCRYPTION_KEY_B64);
  stubProbeFetch();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe.skipIf(skip)('POST /api/setup/validate credential fallback', () => {
  it('tests the env secret when the form sends none (music/suno)', async () => {
    vi.stubEnv('SUNO_API_KEY', 'env-suno-key');
    const res = await postJson({ providerType: 'music', providerKey: 'suno' });
    const data = (await res.json()) as {
      ok: boolean;
      reason: string;
      detail?: { credits?: number };
    };
    expect(data.ok).toBe(true);
    expect(data.reason).toBe('ok');
    expect(data.detail?.credits).toBe(42);
    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0]!.url).toBe('https://api.sunoapi.org/api/v1/generate/credit');
    expect(probeCalls[0]!.authorization).toBe('Bearer env-suno-key');
  });

  it('lets an explicit body secret win over the env key', async () => {
    vi.stubEnv('SUNO_API_KEY', 'env-suno-key');
    const res = await postJson({ providerType: 'music', providerKey: 'suno', secret: 'typed-key' });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(probeCalls[0]!.authorization).toBe('Bearer typed-key');
  });

  it('reports misconfigured without probing when nothing is configured anywhere', async () => {
    const res = await postJson({ providerType: 'music', providerKey: 'suno' });
    const data = (await res.json()) as { ok: boolean; reason: string };
    expect(data.ok).toBe(false);
    expect(data.reason).toBe('misconfigured');
    expect(probeCalls).toHaveLength(0);
  });

  it('falls back to the stored encrypted secret when no env key is set', async () => {
    await upsertProviderCredential(testDb.db, {
      providerType: 'music',
      providerKey: 'suno',
      displayName: 'Suno',
      secret: 'stored-suno-key',
      encryptionKey: ENCRYPTION_KEY,
    });
    const res = await postJson({ providerType: 'music', providerKey: 'suno' });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(probeCalls[0]!.authorization).toBe('Bearer stored-suno-key');
  });

  it('tests the provider default when the form clears a stored base URL', async () => {
    await upsertProviderCredential(testDb.db, {
      providerType: 'music',
      providerKey: 'suno',
      displayName: 'Suno',
      secret: 'stored-suno-key',
      config: { baseUrl: 'https://custom.example.org' },
      encryptionKey: ENCRYPTION_KEY,
    });
    const res = await postJson({ providerType: 'music', providerKey: 'suno', baseUrl: '' });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(probeCalls[0]!.url).toBe('https://api.sunoapi.org/api/v1/generate/credit');
  });

  it('tests the env-configured LLM (openrouter) key and model with an empty form', async () => {
    vi.stubEnv('LLM_PROVIDER', 'openrouter');
    vi.stubEnv('LLM_API_KEY', 'env-llm-key');
    vi.stubEnv('LLM_MODEL', 'env/model');
    const res = await postJson({ providerType: 'llm', providerKey: 'openrouter' });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(probeCalls).toEqual([
      { url: 'https://openrouter.ai/api/v1/key', authorization: 'Bearer env-llm-key' },
      { url: 'https://openrouter.ai/api/v1/model/env/model', authorization: 'Bearer env-llm-key' },
    ]);
  });

  it('tests the typed LLM model unless LLM_MODEL outranks it for this provider', async () => {
    const body = {
      providerType: 'llm',
      providerKey: 'openai',
      secret: 'sk-typed',
      model: 'typed-model',
    };
    await postJson(body);
    expect(probeCalls.map((call) => call.url)).toEqual([
      'https://api.openai.com/v1/models/typed-model',
    ]);

    probeCalls.length = 0;
    vi.stubEnv('LLM_PROVIDER', 'openai');
    vi.stubEnv('LLM_MODEL', 'env-model');
    await postJson(body);
    expect(probeCalls.map((call) => call.url)).toEqual([
      'https://api.openai.com/v1/models/env-model',
    ]);
  });

  it('tests a Gemini key from .env and its default model on the free model list', async () => {
    vi.stubEnv('LLM_PROVIDER', 'gemini');
    vi.stubEnv('LLM_API_KEY', 'env-gemini-key');
    stubProbeFetch(200, { object: 'list', data: [{ id: 'models/gemini-3.8-flash' }] });
    const res = await postJson({ providerType: 'llm', providerKey: 'gemini' });
    expect(await res.json()).toMatchObject({ ok: true, reason: 'ok' });
    expect(probeCalls).toEqual([
      {
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
        authorization: 'Bearer env-gemini-key',
      },
    ]);

    stubProbeFetch(200, { object: 'list', data: [{ id: 'models/gemini-3.8-flash' }] });
    const missing = await postJson({
      providerType: 'llm',
      providerKey: 'gemini',
      secret: 'typed-key',
      model: 'gemini-9-flash',
    });
    expect(await missing.json()).toMatchObject({ ok: false, reason: 'unknown_model' });
  });

  it('names the provider and the model when the key works but the model does not exist', async () => {
    stubProbeFetch(404, { error: { message: 'Not Found', code: 404 } });
    const res = await postJson({
      providerType: 'llm',
      providerKey: 'openai',
      secret: 'sk-typed',
      model: 'gpt-5-mni',
    });
    expect(await res.json()).toMatchObject({
      ok: false,
      reason: 'unknown_model',
      message: 'Key works, but OpenAI has no model “gpt-5-mni”. Check the model ID for typos.',
    });

    stubProbeFetch(401, {});
    const rejected = await postJson({
      providerType: 'image',
      providerKey: 'openrouter',
      secret: 'sk-wrong',
      model: 'google/gemini-3.1-flash-image',
    });
    expect(await rejected.json()).toMatchObject({
      reason: 'unauthorized',
      message: 'OpenRouter rejected this API key.',
    });
  });

  it('tests the cover-image key saved in the app, with its saved model, on free endpoints', async () => {
    await upsertProviderCredential(testDb.db, {
      providerType: 'image',
      providerKey: 'openrouter',
      displayName: 'OpenRouter',
      secret: 'stored-image-key',
      config: { model: 'saved/model' },
      encryptionKey: ENCRYPTION_KEY,
    });
    const res = await postJson({ providerType: 'image', providerKey: 'openrouter' });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(probeCalls).toEqual([
      { url: 'https://openrouter.ai/api/v1/key', authorization: 'Bearer stored-image-key' },
      {
        url: 'https://openrouter.ai/api/v1/images/models/saved/model/endpoints',
        authorization: 'Bearer stored-image-key',
      },
    ]);
  });

  it('tests the typed image model unless IMAGE_MODEL outranks it', async () => {
    const body = {
      providerType: 'image',
      providerKey: 'openrouter',
      secret: 'typed-image-key',
      model: 'typed/model',
    };
    await postJson(body);
    expect(probeCalls[1]!.url).toBe(
      'https://openrouter.ai/api/v1/images/models/typed/model/endpoints',
    );

    probeCalls.length = 0;
    vi.stubEnv('IMAGE_MODEL', 'env/model');
    await postJson(body);
    expect(probeCalls[1]!.url).toBe(
      'https://openrouter.ai/api/v1/images/models/env/model/endpoints',
    );
  });

  it('tests the env image key when IMAGE_PROVIDER names the provider', async () => {
    vi.stubEnv('IMAGE_PROVIDER', 'openrouter');
    vi.stubEnv('IMAGE_API_KEY', 'env-image-key');
    const res = await postJson({ providerType: 'image', providerKey: 'openrouter' });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(probeCalls[0]!.authorization).toBe('Bearer env-image-key');
  });

  it('tests an OpenAI Cover key and its default image model with a free model lookup', async () => {
    vi.stubEnv('IMAGE_PROVIDER', 'openai');
    vi.stubEnv('IMAGE_API_KEY', 'env-openai-image-key');
    stubProbeFetch(200, { id: 'gpt-image-2.6-flare', object: 'model' });
    const res = await postJson({ providerType: 'image', providerKey: 'openai' });
    expect(await res.json()).toMatchObject({ ok: true, reason: 'ok' });
    expect(probeCalls).toEqual([
      {
        url: 'https://api.openai.com/v1/models/gpt-image-2.6-flare',
        authorization: 'Bearer env-openai-image-key',
      },
    ]);

    stubProbeFetch(404, {
      error: { message: 'The model does not exist', code: 'model_not_found' },
    });
    const missing = await postJson({
      providerType: 'image',
      providerKey: 'openai',
      secret: 'typed-key',
      model: 'gpt-image-9',
    });
    expect(await missing.json()).toMatchObject({ ok: false, reason: 'unknown_model' });
  });

  it("tests a Gemini Cover key and its default image model on Google's free model list", async () => {
    vi.stubEnv('IMAGE_PROVIDER', 'gemini');
    vi.stubEnv('IMAGE_API_KEY', 'env-gemini-image-key');
    const list = { object: 'list', data: [{ id: 'models/gemini-nano-banana-2.1' }] };
    stubProbeFetch(200, list);
    const res = await postJson({ providerType: 'image', providerKey: 'gemini' });
    expect(await res.json()).toMatchObject({ ok: true, reason: 'ok' });
    expect(probeCalls).toEqual([
      {
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
        authorization: 'Bearer env-gemini-image-key',
      },
    ]);

    stubProbeFetch(200, list);
    const missing = await postJson({
      providerType: 'image',
      providerKey: 'gemini',
      secret: 'typed-key',
      model: 'gemini-9-image',
    });
    expect(await missing.json()).toMatchObject({ ok: false, reason: 'unknown_model' });
  });

  it('tests Cover images with the shared Text AI key when no key is typed', async () => {
    await upsertProviderCredential(testDb.db, {
      providerType: 'llm',
      providerKey: 'openai',
      displayName: 'OpenAI',
      secret: 'stored-text-key',
      encryptionKey: ENCRYPTION_KEY,
    });
    stubProbeFetch(200, { id: 'gpt-image-2.6-flare', object: 'model' });

    const res = await postJson({ providerType: 'image', providerKey: 'openai' });

    expect(await res.json()).toMatchObject({ ok: true, reason: 'ok' });
    expect(probeCalls).toEqual([
      {
        url: 'https://api.openai.com/v1/models/gpt-image-2.6-flare',
        authorization: 'Bearer stored-text-key',
      },
    ]);
  });

  it('tests the shared Text AI key, not the own Cover key, when the form shares it', async () => {
    for (const [providerType, secret] of [
      ['llm', 'stored-text-key'],
      ['image', 'own-image-key'],
    ] as const) {
      await upsertProviderCredential(testDb.db, {
        providerType,
        providerKey: 'openai',
        displayName: 'OpenAI',
        secret,
        encryptionKey: ENCRYPTION_KEY,
      });
    }
    stubProbeFetch(200, { id: 'gpt-image-2.6-flare', object: 'model' });

    const res = await postJson({
      providerType: 'image',
      providerKey: 'openai',
      shareTextLlmKey: true,
    });

    expect(await res.json()).toMatchObject({ ok: true, reason: 'ok' });
    expect(probeCalls.map((call) => call.authorization)).toEqual(['Bearer stored-text-key']);
  });

  it('still tests the env Cover key when the form shares, because saving cannot remove it', async () => {
    await upsertProviderCredential(testDb.db, {
      providerType: 'llm',
      providerKey: 'openai',
      displayName: 'OpenAI',
      secret: 'stored-text-key',
      encryptionKey: ENCRYPTION_KEY,
    });
    vi.stubEnv('IMAGE_PROVIDER', 'openai');
    vi.stubEnv('IMAGE_API_KEY', 'env-image-key');
    stubProbeFetch(200, { id: 'gpt-image-2.6-flare', object: 'model' });

    const res = await postJson({
      providerType: 'image',
      providerKey: 'openai',
      shareTextLlmKey: true,
    });

    expect(await res.json()).toMatchObject({ ok: true, reason: 'ok' });
    expect(probeCalls.map((call) => call.authorization)).toEqual(['Bearer env-image-key']);
  });

  it('refuses a Test that both shares the Text AI key and types its own', async () => {
    stubProbeFetch();

    const res = await postJson({
      providerType: 'image',
      providerKey: 'openai',
      secret: 'typed-key',
      shareTextLlmKey: true,
    });

    expect(res.status).toBe(400);
    expect(probeCalls).toEqual([]);
  });

  it('applies the SSRF guard to a base URL resolved from stored config', async () => {
    await upsertProviderCredential(testDb.db, {
      providerType: 'llm',
      providerKey: 'openai-compatible',
      displayName: 'Custom LLM',
      secret: 'stored-llm-key',
      config: { baseUrl: 'http://169.254.169.254/v1', model: 'some-model' },
      encryptionKey: ENCRYPTION_KEY,
    });
    const res = await postJson({ providerType: 'llm', providerKey: 'openai-compatible' });
    expect(res.status).toBe(400);
    expect(probeCalls).toHaveLength(0);
  });

  it('tests an undecryptable stored secret as unconfigured (rotated key)', async () => {
    await upsertProviderCredential(testDb.db, {
      providerType: 'music',
      providerKey: 'suno',
      displayName: 'Suno',
      secret: 'stored-suno-key',
      encryptionKey: ENCRYPTION_KEY,
    });
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', '');
    const res = await postJson({ providerType: 'music', providerKey: 'suno' });
    const data = (await res.json()) as { ok: boolean; reason: string };
    expect(data.ok).toBe(false);
    expect(data.reason).toBe('misconfigured');
    expect(probeCalls).toHaveLength(0);
  });
});
