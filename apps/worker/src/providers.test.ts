import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@liedmotif/db';
import type { GeneratedImageProvider } from '@liedmotif/providers';
import {
  buildWorkerProviders,
  createWorkerCoverArtResolver,
  createWorkerLlmResolver,
  createWorkerMusicResolver,
  describeProviders,
  prewarmGeneratedImageProvider,
  type WorkerProviders,
} from './providers';

function providerWithValidation(
  validateCredentials: GeneratedImageProvider['validateCredentials'],
): GeneratedImageProvider {
  return {
    providerType: 'image',
    providerKey: 'test-images',
    model: 'test-model',
    validateCredentials,
    async getCapabilities() {
      throw new Error('not used by startup validation');
    },
    async generate() {
      throw new Error('not used by startup validation');
    },
  };
}

describe('generated image provider startup', () => {
  it('validates a configured adapter before jobs can use it', async () => {
    const validateCredentials = vi.fn(async () => ({ ok: true }));
    const provider = providerWithValidation(validateCredentials);

    await expect(prewarmGeneratedImageProvider(provider)).resolves.toBe(true);
    expect(validateCredentials).toHaveBeenCalledOnce();
  });

  it('treats an absent optional adapter as ready', async () => {
    await expect(prewarmGeneratedImageProvider(null)).resolves.toBe(true);
  });

  it('contains adapter validation failures', async () => {
    const provider = providerWithValidation(async () => {
      throw new Error('private provider detail');
    });
    await expect(prewarmGeneratedImageProvider(provider)).resolves.toBe(false);
  });
});

describe('worker text-LLM resolution', () => {
  // The DB read is an injected seam; the handle itself is only threaded through.
  const db = {} as Database;
  const resolvedLlm = (providerKey: string, model: string, apiKey: string | null = null) => ({
    providerKey,
    apiKey,
    settings: { model, supportsStructuredOutputs: false },
  });

  it('resolves null when no text LLM is configured', async () => {
    const resolver = createWorkerLlmResolver({
      db,
      encryptionKey: null,
      env: {},
      readConfig: async () => null,
    });
    await expect(resolver.getLlm()).resolves.toBeNull();
    expect(resolver.resolvedLlmKey()).toBe('none');
  });

  it('builds the resolved provider with its resolved settings', async () => {
    const resolver = createWorkerLlmResolver({
      db,
      encryptionKey: null,
      readConfig: async () => resolvedLlm('ollama', 'llama3'),
    });
    const provider = await resolver.getLlm();
    expect(provider?.providerKey).toBe('ollama');
    expect(provider?.getCapabilities().model).toBe('llama3');
    expect(resolver.resolvedLlmKey()).toBe('ollama');
  });

  it('reuses the cached adapter until the resolved config changes', async () => {
    let storedModel = 'llama3';
    const resolver = createWorkerLlmResolver({
      db,
      encryptionKey: null,
      readConfig: async () => resolvedLlm('ollama', storedModel),
    });
    const first = await resolver.getLlm();
    expect(first).not.toBeNull();
    expect(await resolver.getLlm()).toBe(first);

    storedModel = 'llama4';
    const changed = await resolver.getLlm();
    expect(changed).not.toBe(first);
    expect(changed?.getCapabilities().model).toBe('llama4');
  });

  it('keeps secret material out of the boot-log description', async () => {
    const secret = 'sk-super-secret-value';
    const resolver = createWorkerLlmResolver({
      db,
      encryptionKey: null,
      readConfig: async () => resolvedLlm('openai', '', secret),
    });
    await resolver.getLlm();

    const providers = {
      musicSelection: 'mock',
      storage: { providerKey: 'local-fs' },
    } as unknown as WorkerProviders;
    const described = JSON.stringify(describeProviders(providers, resolver));
    expect(described).toContain('"llm":"openai"');
    expect(described).not.toContain(secret);
  });
});

describe('worker music provider resolution', () => {
  const db = {} as Database;

  it('boots with Suno selected and no key anywhere', () => {
    expect(buildWorkerProviders({ MUSIC_PROVIDER: 'suno' }).musicSelection).toBe('suno');
  });

  it('refuses an unknown MUSIC_PROVIDER at boot', () => {
    expect(() => buildWorkerProviders({ MUSIC_PROVIDER: 'sunno' })).toThrow(/sunno/);
  });

  it('fails a music job clearly while no key is saved, and draws no Suno Covers', async () => {
    const resolver = createWorkerMusicResolver({
      db,
      encryptionKey: null,
      selection: 'suno',
      readConfig: async () => ({}),
    });
    await expect(resolver.getMusic()).rejects.toThrow(/needs an API key/);
    await expect(resolver.getSunoCoverArt()).resolves.toBeNull();
  });

  it('uses a key saved in the app after boot, with no restart', async () => {
    let saved: { apiKey?: string } = {};
    const resolver = createWorkerMusicResolver({
      db,
      encryptionKey: null,
      selection: 'suno',
      readConfig: async () => saved,
    });
    await expect(resolver.getMusic()).rejects.toThrow();

    saved = { apiKey: 'sk-saved-in-onboarding' };
    const music = await resolver.getMusic();
    expect(music.providerKey).toBe('suno');
    expect(await resolver.getMusic()).toBe(music);
    expect(await resolver.getSunoCoverArt()).not.toBeNull();
  });

  it('runs the mock without reading any credential', async () => {
    const readConfig = vi.fn(async () => ({}));
    const resolver = createWorkerMusicResolver({
      db,
      encryptionKey: null,
      selection: 'mock',
      readConfig,
    });
    expect((await resolver.getMusic()).providerKey).toBe('mock');
    await expect(resolver.getSunoCoverArt()).resolves.toBeNull();
    expect(readConfig).not.toHaveBeenCalled();
  });
});

describe('worker cover-art resolution', () => {
  const db = {} as Database;

  it('boots with an image provider named and no key anywhere', () => {
    expect(() => buildWorkerProviders({ IMAGE_PROVIDER: 'openrouter' })).not.toThrow();
    expect(() => buildWorkerProviders({ IMAGE_PROVIDER: 'openai' })).not.toThrow();
  });

  it('refuses an unknown IMAGE_PROVIDER at boot', () => {
    expect(() => buildWorkerProviders({ IMAGE_PROVIDER: 'dall-e' })).toThrow(/dall-e/);
  });

  it('draws no generated Covers while no image key exists', async () => {
    const unselected = createWorkerCoverArtResolver({
      db,
      encryptionKey: null,
      readConfig: async () => null,
    });
    await expect(unselected.getCoverArt()).resolves.toBeNull();

    const keyless = createWorkerCoverArtResolver({
      db,
      encryptionKey: null,
      readConfig: async () => ({ providerKey: 'openrouter' }),
    });
    await expect(keyless.getCoverArt()).resolves.toBeNull();
  });

  it('uses an image key saved in the app after boot, with no restart', async () => {
    let saved: { providerKey: string; apiKey?: string } | null = null;
    const resolver = createWorkerCoverArtResolver({
      db,
      encryptionKey: null,
      readConfig: async () => saved,
    });
    await expect(resolver.getCoverArt()).resolves.toBeNull();

    saved = { providerKey: 'openrouter', apiKey: 'sk-or-saved-in-onboarding' };
    const coverArt = await resolver.getCoverArt();
    expect(coverArt?.providerKey).toBe('openrouter');
    // The adapter caches what its model accepts, so it is kept until the config changes.
    expect(await resolver.getCoverArt()).toBe(coverArt);
  });
});
