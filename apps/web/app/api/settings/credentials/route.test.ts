import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chunkedJsonRequest, fillerChunks } from '../../../../tests/helpers/chunked-request';

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  delete: vi.fn(async () => true),
  adminSession: vi.fn(),
  encryptionKey: vi.fn((): Buffer | undefined => undefined),
  storedConfig: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  credentialStatus: vi.fn(async () => ({ configured: false })),
  envLayer: vi.fn((): Record<string, string> => ({})),
  unitCosts: vi.fn(async () => ({ perTrackUsd: 0.04, perCoverUsd: 0.07 })),
  updateUnitCosts: vi.fn(async () => ({ perTrackUsd: 0.04, perCoverUsd: 0.07 })),
  sharedImageKey: vi.fn(async (): Promise<string | undefined> => undefined),
  coverKeyState: vi.fn(async () => ({
    sharedKeyVendor: null as string | null,
    coverConnected: false,
  })),
}));

vi.mock('@liedmotif/db', async (importOriginal) => ({
  selectProviderKey: (await importOriginal<typeof import('@liedmotif/db')>()).selectProviderKey,
  getCredentialStatus: mocks.credentialStatus,
  getStoredProviderConfig: mocks.storedConfig,
  readEnvLayer: mocks.envLayer,
  deleteProviderCredential: mocks.delete,
  upsertProviderCredential: mocks.upsert,
  getUnitCosts: mocks.unitCosts,
  updateUnitCosts: mocks.updateUnitCosts,
  resolveSharedImageKey: mocks.sharedImageKey,
}));
// Only the DNS-resolving SSRF probe is stubbed; the base-URL rule is the real
// one, so this file proves what the route actually stores.
vi.mock('@liedmotif/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@liedmotif/providers')>()),
  isBlockedValidationTargetResolved: vi.fn(async () => false),
}));
vi.mock('@/lib/credentials', () => ({ encryptionKeyIfConfigured: mocks.encryptionKey }));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/provider-settings-data', () => ({ loadCoverKeyState: mocks.coverKeyState }));
vi.mock('@/lib/session', () => ({
  getAdminSession: mocks.adminSession,
}));

const { DELETE, GET, POST } = await import('./route');

describe('provider credential writes', () => {
  beforeEach(() => {
    mocks.upsert.mockClear();
    mocks.delete.mockClear();
    mocks.adminSession.mockResolvedValue({ user: { id: 'admin-1' } });
    mocks.encryptionKey.mockReturnValue(undefined);
    mocks.storedConfig.mockResolvedValue(null);
    mocks.envLayer.mockReturnValue({});
    mocks.unitCosts.mockResolvedValue({ perTrackUsd: 0.04, perCoverUsd: 0.07 });
    mocks.updateUnitCosts.mockClear();
    mocks.credentialStatus.mockResolvedValue({ configured: false });
    mocks.sharedImageKey.mockResolvedValue(undefined);
    // The developer's .env must not pick the Cover provider these saves price.
    vi.stubEnv('IMAGE_PROVIDER', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses a base URL carrying credentials before it can be stored', async () => {
    // Config is plaintext and is read back by the admin frontend, so a pasted
    // `https://user:pass@host` would ship a secret to the database and browser.
    mocks.encryptionKey.mockReturnValue(Buffer.alloc(32));
    const response = await POST(
      new Request('http://localhost/api/settings/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerType: 'music',
          providerKey: 'suno',
          baseUrl: 'https://someone:hunter2@api.example.org/v1',
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: expect.stringContaining('API key field'),
    });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('stores a plain base URL with its path untouched', async () => {
    mocks.encryptionKey.mockReturnValue(Buffer.alloc(32));
    const response = await POST(
      new Request('http://localhost/api/settings/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerType: 'music',
          providerKey: 'suno',
          secret: 'suno-key',
          baseUrl: 'https://api.example.org/v1',
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ config: { baseUrl: 'https://api.example.org/v1' } }),
    );
  });

  it('drops a cleared base URL from the stored config and keeps the stored model', async () => {
    mocks.encryptionKey.mockReturnValue(Buffer.alloc(32));
    mocks.storedConfig.mockResolvedValue({
      baseUrl: 'http://ollama.lan:11434',
      model: 'llama3.1',
    });
    const response = await POST(
      new Request('http://localhost/api/settings/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerType: 'llm', providerKey: 'ollama', baseUrl: '' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ config: { model: 'llama3.1' } }),
    );
  });

  it('refuses an OpenAI-compatible Text AI with no base URL anywhere', async () => {
    // Its builder needs an explicit endpoint, so the row would be the selected LLM
    // while every Session silently compiled without it.
    mocks.encryptionKey.mockReturnValue(Buffer.alloc(32));
    const fresh = await POST(
      new Request('http://localhost/api/settings/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerType: 'llm',
          providerKey: 'openai-compatible',
          secret: 'sk-x',
          model: 'my-model',
        }),
      }),
    );
    expect(fresh.status).toBe(400);

    mocks.storedConfig.mockResolvedValue({ baseUrl: 'https://llm.example.org/v1', model: 'm' });
    const cleared = await POST(
      new Request('http://localhost/api/settings/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerType: 'llm',
          providerKey: 'openai-compatible',
          baseUrl: '',
        }),
      }),
    );
    expect(cleared.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('accepts a Text AI key-only save whose model comes from .env, storing no model', async () => {
    mocks.encryptionKey.mockReturnValue(Buffer.alloc(32));
    mocks.envLayer.mockReturnValue({ model: 'env-model', baseUrl: 'https://llm.example.org/v1' });
    const response = await POST(
      new Request('http://localhost/api/settings/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerType: 'llm',
          providerKey: 'openai-compatible',
          secret: 'sk-x',
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({
        config: expect.objectContaining({ model: expect.anything() }),
      }),
    );
  });

  it('accepts Gemini as the Text AI without a model, so its default model applies', async () => {
    mocks.encryptionKey.mockReturnValue(Buffer.alloc(32));
    const response = await POST(
      new Request('http://localhost/api/settings/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerType: 'llm', providerKey: 'gemini', secret: 'AIza-1' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ providerType: 'llm', providerKey: 'gemini', secret: 'AIza-1' }),
    );
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({
        config: expect.objectContaining({ model: expect.anything() }),
      }),
    );
  });

  it('blocks config-only database writes when credential encryption is unavailable', async () => {
    const response = await POST(
      new Request('http://localhost/api/settings/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerType: 'music',
          providerKey: 'suno',
          baseUrl: 'https://api.sunoapi.org',
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'CREDENTIAL_ENCRYPTION_KEY must be configured to store provider settings.',
    });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('rejects an unsupported provider before it can replace a configured credential', async () => {
    const response = await POST(
      new Request('http://localhost/api/settings/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerType: 'llm',
          providerKey: 'unregistered-provider',
          secret: 'should-not-be-stored',
          model: 'some-model',
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'Unsupported provider.' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('stores the cover-image key encrypted, with its model in the plain config', async () => {
    const encryptionKey = Buffer.alloc(32);
    mocks.encryptionKey.mockReturnValue(encryptionKey);
    const response = await POST(
      new Request('http://localhost/api/settings/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerType: 'image',
          providerKey: 'openrouter',
          secret: 'sk-or-image-key',
          model: ' google/gemini-3.1-flash-image ',
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        providerType: 'image',
        providerKey: 'openrouter',
        secret: 'sk-or-image-key',
        config: { model: 'google/gemini-3.1-flash-image' },
        encryptionKey,
      }),
    );
    expect(await response.json()).toEqual({ ok: true });
  });

  it('accepts OpenAI for Cover images without a model, so its default model applies', async () => {
    mocks.encryptionKey.mockReturnValue(Buffer.alloc(32));
    const response = await POST(
      new Request('http://localhost/api/settings/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerType: 'image', providerKey: 'openai', secret: 'sk-proj-1' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        providerType: 'image',
        providerKey: 'openai',
        secret: 'sk-proj-1',
      }),
    );
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({
        config: expect.objectContaining({ model: expect.anything() }),
      }),
    );
  });

  it('accepts Gemini for Cover images without a model, so its default model applies', async () => {
    mocks.encryptionKey.mockReturnValue(Buffer.alloc(32));
    const response = await POST(
      new Request('http://localhost/api/settings/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerType: 'image', providerKey: 'gemini', secret: 'AIza-1' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ providerType: 'image', providerKey: 'gemini', secret: 'AIza-1' }),
    );
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({
        config: expect.objectContaining({ model: expect.anything() }),
      }),
    );
  });

  function saveImage(providerKey: string) {
    return POST(
      new Request('http://localhost/api/settings/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerType: 'image', providerKey, secret: 'image-key' }),
      }),
    );
  }

  it('moves the price per Cover to the saved provider while it is still a list price', async () => {
    mocks.encryptionKey.mockReturnValue(Buffer.alloc(32));

    expect((await saveImage('gemini')).status).toBe(200);
    expect(mocks.updateUnitCosts).toHaveBeenLastCalledWith({}, { perCoverUsd: 0.04 });

    mocks.unitCosts.mockResolvedValue({ perTrackUsd: 0.04, perCoverUsd: 0.04 });
    expect((await saveImage('openai')).status).toBe(200);
    expect(mocks.updateUnitCosts).toHaveBeenLastCalledWith({}, { perCoverUsd: 0.06 });

    mocks.unitCosts.mockResolvedValue({ perTrackUsd: 0.04, perCoverUsd: 0.06 });
    expect((await saveImage('openrouter')).status).toBe(200);
    expect(mocks.updateUnitCosts).toHaveBeenLastCalledWith({}, { perCoverUsd: 0.07 });
  });

  it('leaves the price per Cover alone when .env selects another Cover provider', async () => {
    mocks.encryptionKey.mockReturnValue(Buffer.alloc(32));
    vi.stubEnv('IMAGE_PROVIDER', 'openrouter');
    expect((await saveImage('gemini')).status).toBe(200);

    expect(mocks.updateUnitCosts).not.toHaveBeenCalled();
  });

  it("leaves the Admin's own price per Cover alone when the provider changes", async () => {
    mocks.encryptionKey.mockReturnValue(Buffer.alloc(32));
    for (const perCoverUsd of [0.05, 0]) {
      mocks.unitCosts.mockResolvedValue({ perTrackUsd: 0.04, perCoverUsd });
      expect((await saveImage('gemini')).status).toBe(200);
    }

    expect(mocks.updateUnitCosts).not.toHaveBeenCalled();
  });

  it('leaves the price per Cover alone when a Text AI is saved', async () => {
    mocks.encryptionKey.mockReturnValue(Buffer.alloc(32));
    const response = await POST(
      new Request('http://localhost/api/settings/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerType: 'llm', providerKey: 'gemini', secret: 'AIza-1' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.updateUnitCosts).not.toHaveBeenCalled();
  });

  it('refuses an image save with no key anywhere', async () => {
    mocks.encryptionKey.mockReturnValue(Buffer.alloc(32));
    const response = await POST(
      new Request('http://localhost/api/settings/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerType: 'image', providerKey: 'openrouter' }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  function postImage(body: Record<string, unknown>) {
    return POST(
      new Request('http://localhost/api/settings/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerType: 'image', ...body }),
      }),
    );
  }

  it('accepts an image save without a key when it shares the Text AI key', async () => {
    mocks.encryptionKey.mockReturnValue(Buffer.alloc(32));
    mocks.credentialStatus.mockResolvedValue({ configured: true });

    const response = await postImage({ providerKey: 'openai' });

    expect(response.status).toBe(200);
    expect(mocks.credentialStatus).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ providerType: 'image', providerKey: 'openai' }),
    );
    expect(mocks.upsert).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ providerType: 'image', providerKey: 'openai', secret: undefined }),
    );
  });

  it('removes the own image key when the save asks to share the Text AI key', async () => {
    mocks.encryptionKey.mockReturnValue(Buffer.alloc(32));
    mocks.sharedImageKey.mockResolvedValue('AIza-text');

    const response = await postImage({ providerKey: 'gemini', shareTextLlmKey: true });

    expect(response.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ providerType: 'image', providerKey: 'gemini', secret: null }),
    );
    expect(mocks.updateUnitCosts).toHaveBeenLastCalledWith({}, { perCoverUsd: 0.04 });
    expect(JSON.stringify(await response.json())).not.toContain('AIza-text');
  });

  it('refuses to share a key that does not resolve for that provider', async () => {
    mocks.encryptionKey.mockReturnValue(Buffer.alloc(32));
    mocks.sharedImageKey.mockResolvedValue(undefined);

    const response = await postImage({ providerKey: 'gemini', shareTextLlmKey: true });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'An API key is required for this provider.',
    });
    expect(mocks.sharedImageKey).toHaveBeenCalledWith({}, 'gemini', expect.anything());
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('refuses a save that both shares the Text AI key and sends its own', async () => {
    mocks.encryptionKey.mockReturnValue(Buffer.alloc(32));
    mocks.sharedImageKey.mockResolvedValue('sk-proj-text');

    const response = await postImage({
      providerKey: 'openai',
      secret: 'sk-proj-image',
      shareTextLlmKey: true,
    });

    expect(response.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('deletes only the requested stored text LLM credential', async () => {
    const response = await DELETE(
      new Request('http://localhost/api/settings/credentials', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerType: 'llm', providerKey: 'openrouter' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, deleted: true });
    expect(mocks.delete).toHaveBeenCalledWith(
      {},
      {
        providerType: 'llm',
        providerKey: 'openrouter',
      },
    );
  });

  it('refuses an undeclared oversized body without buffering it whole', async () => {
    // A chunked POST declares no length, so the route only stays inside the
    // 1 MB app cap if it reads through the shared capped reader.
    const CHUNKS = 32;
    const { request, pulled } = chunkedJsonRequest(
      fillerChunks(CHUNKS, 64 * 1024),
      'http://localhost/api/settings/credentials',
    );

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(pulled()).toBeLessThan(CHUNKS);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('rejects an unauthorized delete without touching storage', async () => {
    mocks.adminSession.mockResolvedValue(null);
    const response = await DELETE(
      new Request('http://localhost/api/settings/credentials', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerType: 'llm', providerKey: 'openrouter' }),
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.delete).not.toHaveBeenCalled();
  });
});

describe('reading the Cover key state after a Text AI save', () => {
  const read = () => GET(new Request('http://localhost/api/settings/credentials'));

  beforeEach(() => {
    mocks.adminSession.mockResolvedValue({ user: { id: 'admin-1' } });
    mocks.coverKeyState.mockClear();
    mocks.coverKeyState.mockResolvedValue({ sharedKeyVendor: null, coverConnected: false });
  });

  it('names the vendor that can share the Text AI key and whether the Cover key resolves', async () => {
    mocks.coverKeyState.mockResolvedValue({ sharedKeyVendor: 'gemini', coverConnected: true });

    const response = await read();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      sharedKeyVendor: 'gemini',
      coverConnected: true,
    });
  });

  it('refuses anyone but the Admin', async () => {
    mocks.adminSession.mockResolvedValue(null);

    expect((await read()).status).toBe(401);
    expect(mocks.coverKeyState).not.toHaveBeenCalled();
  });
});
