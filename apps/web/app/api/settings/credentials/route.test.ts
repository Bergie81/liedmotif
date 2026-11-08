import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chunkedJsonRequest, fillerChunks } from '../../../../tests/helpers/chunked-request';

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  delete: vi.fn(async () => true),
  adminSession: vi.fn(),
  encryptionKey: vi.fn((): Buffer | undefined => undefined),
  storedConfig: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  credentialStatus: vi.fn(async () => ({ configured: false })),
}));

vi.mock('@liedmotif/db', () => ({
  getCredentialStatus: mocks.credentialStatus,
  getStoredProviderConfig: mocks.storedConfig,
  deleteProviderCredential: mocks.delete,
  upsertProviderCredential: mocks.upsert,
}));
// Only the DNS-resolving SSRF probe is stubbed; the base-URL rule is the real
// one, so this file proves what the route actually stores.
vi.mock('@liedmotif/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@liedmotif/providers')>()),
  isBlockedValidationTargetResolved: vi.fn(async () => false),
}));
vi.mock('@/lib/credentials', () => ({ encryptionKeyIfConfigured: mocks.encryptionKey }));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/session', () => ({
  getAdminSession: mocks.adminSession,
}));

const { DELETE, POST } = await import('./route');

describe('provider credential writes', () => {
  beforeEach(() => {
    mocks.upsert.mockClear();
    mocks.delete.mockClear();
    mocks.adminSession.mockResolvedValue({ user: { id: 'admin-1' } });
    mocks.encryptionKey.mockReturnValue(undefined);
    mocks.storedConfig.mockResolvedValue(null);
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
