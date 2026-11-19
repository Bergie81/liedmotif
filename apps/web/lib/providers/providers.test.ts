// The LLM provider memo: the 3 s cover-status poll resolves the provider to a
// single boolean, so an unchanged resolved config must reuse the built adapter
// while any config change still yields a fresh one on its next resolution. And
// the music provider: built from the key saved in the app, resolved per call.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const holder = vi.hoisted(() => ({
  providerKey: 'openai' as string | null,
  secret: 'secret-a' as string | null,
  musicConfig: {} as { apiKey?: string },
}));

vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('./credentials', () => ({
  encryptionKeyIfConfigured: () => undefined,
}));
vi.mock('@liedmotif/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@liedmotif/db')>()),
  resolveLlmRuntimeConfig: async () =>
    holder.providerKey
      ? {
          providerKey: holder.providerKey,
          apiKey: holder.secret,
          settings: { model: 'test-model', supportsStructuredOutputs: false },
        }
      : null,
  resolveMusicRuntimeConfig: async () => holder.musicConfig,
}));

import { getLlmProvider, getMusicProvider } from '@/lib/providers/providers';

describe('getLlmProvider memo', () => {
  afterEach(() => {
    holder.providerKey = 'openai';
    holder.secret = 'secret-a';
  });

  it('returns null when no LLM is configured', async () => {
    holder.providerKey = null;
    await expect(getLlmProvider()).resolves.toBeNull();
  });

  it('reuses the built adapter while the resolved config is unchanged', async () => {
    const first = await getLlmProvider();
    const second = await getLlmProvider();
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it('rebuilds when the resolved config changes', async () => {
    const first = await getLlmProvider();
    holder.secret = 'secret-b';
    const second = await getLlmProvider();
    expect(second).not.toBe(first);
    // And the new config keeps memoizing.
    expect(await getLlmProvider()).toBe(second);
  });
});

describe('getMusicProvider', () => {
  // The env layer is the shared resolver's (mocked here); a key in the
  // developer's `.env` must not stand in for the saved one.
  beforeEach(() => vi.stubEnv('SUNO_API_KEY', ''));
  afterEach(() => {
    vi.unstubAllEnvs();
    holder.musicConfig = {};
  });

  it('builds Suno from the key saved in the app', async () => {
    vi.stubEnv('MUSIC_PROVIDER', 'suno');
    holder.musicConfig = { apiKey: 'sk-saved-in-onboarding' };
    expect((await getMusicProvider()).providerKey).toBe('suno');
  });

  it('refuses clearly while no key exists anywhere', async () => {
    vi.stubEnv('MUSIC_PROVIDER', 'suno');
    await expect(getMusicProvider()).rejects.toThrow(/needs an API key/);
  });
});
