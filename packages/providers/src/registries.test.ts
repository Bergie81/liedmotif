import { describe, expect, it } from 'vitest';
import {
  buildGeneratedImageProvider,
  buildLlmProvider,
  buildMusicProvider,
  imageProviderSelection,
  musicTracksPerRequest,
} from './registries';

describe('buildMusicProvider', () => {
  it('selects the mock provider by default', () => {
    expect(buildMusicProvider().providerKey).toBe('mock');
    expect(buildMusicProvider('mock').providerKey).toBe('mock');
  });

  it('builds the real Suno provider when selected with an API key', () => {
    expect(buildMusicProvider('suno', { apiKey: 'suno-key' }).providerKey).toBe('suno');
  });

  it('requires an API key only when suno is the active selection', () => {
    // mock never needs a key; selecting suno without one is the error.
    expect(() => buildMusicProvider('mock')).not.toThrow();
    expect(() => buildMusicProvider('suno')).toThrow(/api key/i);
    expect(() => buildMusicProvider('suno', { apiKey: '   ' })).toThrow(/api key/i);
  });

  it('throws on an unknown selection', () => {
    expect(() => buildMusicProvider('udio' as never)).toThrow(/unknown/i);
  });
});

// Read on every page render, so it must not need the key the adapter does.
describe('musicTracksPerRequest', () => {
  it('matches what each built provider reports, without a key', () => {
    for (const selection of ['mock', 'suno'] as const) {
      const built = buildMusicProvider(selection, { apiKey: 'key' });
      expect(musicTracksPerRequest(selection)).toBe(
        built.getCapabilities().typicalTracksPerRequest,
      );
    }
  });
});

describe('buildLlmProvider', () => {
  it('returns null when no LLM is configured (the text LLM is optional)', () => {
    expect(buildLlmProvider(null)).toBeNull();
  });

  it('builds the mock and the configured presets by key', () => {
    expect(buildLlmProvider({ providerKey: 'mock', model: 'mock' })?.providerKey).toBe('mock');
    expect(
      buildLlmProvider({ providerKey: 'openrouter', model: 'm', apiKey: 'sk-or-1' })?.providerKey,
    ).toBe('openrouter');
    expect(buildLlmProvider({ providerKey: 'ollama', model: 'llama3' })?.providerKey).toBe(
      'ollama',
    );
  });

  it('builds the hosted openai preset with its model default (gpt-6-luna)', () => {
    const provider = buildLlmProvider({ providerKey: 'openai', model: '', apiKey: 'sk-1' });
    expect(provider?.providerKey).toBe('openai');
    // The preset owns the default: a model-less openai config is still usable.
    expect(provider?.getCapabilities().model).toBe('gpt-6-luna');
  });

  it('keeps an explicit openai model over the preset default', () => {
    const provider = buildLlmProvider({ providerKey: 'openai', model: 'gpt-6', apiKey: 'sk-1' });
    expect(provider?.getCapabilities().model).toBe('gpt-6');
  });

  it('builds the gemini preset with its model default (gemini-3.8-flash)', () => {
    const provider = buildLlmProvider({ providerKey: 'gemini', model: '', apiKey: 'AIza-1' });
    expect(provider?.providerKey).toBe('gemini');
    expect(provider?.getCapabilities().model).toBe('gemini-3.8-flash');
  });

  it('treats gemini without an API key as absent (returns null)', () => {
    expect(buildLlmProvider({ providerKey: 'gemini', model: 'gemini-3.8-flash' })).toBeNull();
  });

  it('treats openai without an API key as absent (returns null)', () => {
    expect(buildLlmProvider({ providerKey: 'openai', model: 'gpt-6-luna' })).toBeNull();
  });

  it('treats a partially-configured real preset as absent (returns null)', () => {
    // Missing the required API key.
    expect(buildLlmProvider({ providerKey: 'openrouter', model: 'm' })).toBeNull();
    // Missing the required model.
    expect(buildLlmProvider({ providerKey: 'ollama', model: '   ' })).toBeNull();
    // openai-compatible needs both base URL and key.
    expect(
      buildLlmProvider({ providerKey: 'openai-compatible', model: 'm', apiKey: 'k' }),
    ).toBeNull();
  });

  it('throws on an unknown (misconfigured) provider key', () => {
    expect(() =>
      buildLlmProvider({ providerKey: 'opnrouter' as never, model: 'm', apiKey: 'k' }),
    ).toThrow(/unknown/i);
  });
});

describe('buildGeneratedImageProvider', () => {
  it('builds the OpenAI adapter with its default model, or the configured one', () => {
    const preset = buildGeneratedImageProvider({ providerKey: 'openai', apiKey: 'sk-proj-1' });
    expect(preset).toMatchObject({ providerKey: 'openai', model: 'gpt-image-2.6-flare' });
    const configured = buildGeneratedImageProvider({
      providerKey: 'openai',
      apiKey: 'sk-proj-1',
      model: ' gpt-image-2.5-flare ',
    });
    expect(configured?.model).toBe('gpt-image-2.5-flare');
  });

  it('builds the OpenRouter adapter with its default model', () => {
    const provider = buildGeneratedImageProvider({ providerKey: 'openrouter', apiKey: 'sk-or-1' });
    expect(provider).toMatchObject({
      providerKey: 'openrouter',
      model: 'google/gemini-3.1-flash-image',
    });
  });

  it('builds nothing when no key resolves, so Covers fall back', () => {
    expect(buildGeneratedImageProvider(null)).toBeNull();
    expect(buildGeneratedImageProvider({ providerKey: 'openai' })).toBeNull();
    expect(buildGeneratedImageProvider({ providerKey: 'openai', apiKey: '  ' })).toBeNull();
    expect(buildGeneratedImageProvider({ providerKey: 'openrouter' })).toBeNull();
  });

  it('throws on an unknown provider name, with or without a key', () => {
    expect(() => buildGeneratedImageProvider({ providerKey: 'dall-e', apiKey: 'k' })).toThrow(
      /dall-e/,
    );
    expect(() => buildGeneratedImageProvider({ providerKey: 'dall-e' })).toThrow(/dall-e/);
  });
});

describe('imageProviderSelection', () => {
  it('accepts openai and openrouter, names none when blank, and refuses a typo', () => {
    expect(imageProviderSelection(' openai ')).toBe('openai');
    expect(imageProviderSelection('openrouter')).toBe('openrouter');
    expect(imageProviderSelection('  ')).toBeNull();
    expect(() => imageProviderSelection('opneai')).toThrow(/opneai/);
  });
});
