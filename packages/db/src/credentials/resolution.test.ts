import { describe, expect, it } from 'vitest';
import {
  readEnvLayer,
  resolveCredentialSource,
  resolveLlmRuntimeSettings,
  resolveProviderSettings,
  selectProviderKey,
} from './resolution';

const envKey = (...args: Parameters<typeof readEnvLayer>) => readEnvLayer(...args).apiKey;

describe('env key variables', () => {
  it('maps the music/suno requirement to SUNO_API_KEY', () => {
    expect(envKey('music', 'suno', { SUNO_API_KEY: 'sk-suno' })).toBe('sk-suno');
  });

  it('maps any llm provider to LLM_API_KEY (env configures a single LLM)', () => {
    expect(envKey('llm', 'openrouter', { LLM_PROVIDER: 'openrouter', LLM_API_KEY: 'k' })).toBe('k');
    expect(envKey('llm', 'ollama', { LLM_PROVIDER: 'ollama', LLM_API_KEY: 'k' })).toBe('k');
  });

  it('has no env secret for storage providers', () => {
    expect(readEnvLayer('storage', 'local-fs', { SUNO_API_KEY: 'k', LLM_API_KEY: 'k' })).toEqual(
      {},
    );
  });
});

describe('readEnvLayer key', () => {
  it('reads the mapped env var, trimmed', () => {
    expect(envKey('music', 'suno', { SUNO_API_KEY: '  sk-suno-123  ' })).toBe('sk-suno-123');
  });

  it('treats blank/whitespace as absent', () => {
    expect(envKey('music', 'suno', { SUNO_API_KEY: '' })).toBeUndefined();
    expect(envKey('music', 'suno', { SUNO_API_KEY: '   ' })).toBeUndefined();
    expect(envKey('music', 'suno', {})).toBeUndefined();
  });

  it('binds LLM_API_KEY to the env-declared LLM_PROVIDER only', () => {
    const env = { LLM_PROVIDER: 'openrouter', LLM_API_KEY: 'sk-or-123' };
    // Matches the env-declared provider -> the env key applies.
    expect(envKey('llm', 'openrouter', env)).toBe('sk-or-123');
    // A different provider must NOT inherit the env key.
    expect(envKey('llm', 'ollama', env)).toBeUndefined();
  });

  it('ignores a bare LLM_API_KEY with no LLM_PROVIDER (provider unspecified)', () => {
    expect(envKey('llm', 'openrouter', { LLM_API_KEY: 'sk-or-123' })).toBeUndefined();
  });

  it('binds IMAGE_API_KEY to the env-declared IMAGE_PROVIDER only', () => {
    const env = { IMAGE_PROVIDER: 'openrouter', IMAGE_API_KEY: ' sk-or-img ' };
    expect(envKey('image', 'openrouter', env)).toBe('sk-or-img');
    // A blank IMAGE_PROVIDER is the documented way to make no paid image request.
    expect(envKey('image', 'openrouter', { IMAGE_API_KEY: 'sk-or-img' })).toBeUndefined();
  });
});

describe('selectProviderKey (env selects the provider; DB fills the gap)', () => {
  it('prefers the env LLM_PROVIDER even when a DB provider exists', () => {
    expect(selectProviderKey('llm', { LLM_PROVIDER: 'ollama' }, 'openrouter')).toBe('ollama');
  });

  it('falls back to the DB provider when env is unset', () => {
    expect(selectProviderKey('llm', {}, 'openrouter')).toBe('openrouter');
  });

  it('is null when neither env nor DB has a provider', () => {
    expect(selectProviderKey('llm', {}, null)).toBeNull();
  });
});

describe('resolveLlmRuntimeSettings (env overrides per field, stored config fills gaps)', () => {
  it('uses the stored config when env has no LLM config (wizard-only setup)', () => {
    const settings = resolveLlmRuntimeSettings({
      providerKey: 'openrouter',
      storedConfig: { model: 'minimax/minimax-m2.7', baseUrl: 'https://example.test/v1' },
      env: {},
    });
    expect(settings).toEqual({
      model: 'minimax/minimax-m2.7',
      baseUrl: 'https://example.test/v1',
      supportsStructuredOutputs: false,
    });
  });

  it('lets env win per field when LLM_PROVIDER names the resolved provider', () => {
    const settings = resolveLlmRuntimeSettings({
      providerKey: 'openrouter',
      storedConfig: { model: 'db-model', baseUrl: 'https://db.test/v1' },
      env: { LLM_PROVIDER: 'openrouter', LLM_MODEL: '  env-model  ' },
    });
    // Env model overrides; the stored base URL fills the env gap.
    expect(settings.model).toBe('env-model');
    expect(settings.baseUrl).toBe('https://db.test/v1');
  });

  it('binds env LLM config to the env-declared provider only (like the secret)', () => {
    const env = { LLM_PROVIDER: 'ollama', LLM_MODEL: 'llama3.1' };
    // Resolving a DIFFERENT provider must not inherit the env model.
    const settings = resolveLlmRuntimeSettings({
      providerKey: 'openrouter',
      storedConfig: { model: 'db-model' },
      env,
    });
    expect(settings.model).toBe('db-model');
  });

  it('ignores env LLM config when LLM_PROVIDER is unset (provider came from the DB)', () => {
    const settings = resolveLlmRuntimeSettings({
      providerKey: 'openrouter',
      storedConfig: { model: 'db-model' },
      env: { LLM_MODEL: 'stale-env-model', LLM_SUPPORTS_STRUCTURED_OUTPUTS: 'true' },
    });
    expect(settings.model).toBe('db-model');
    expect(settings.supportsStructuredOutputs).toBe(false);
  });

  it('resolves the structured-outputs flag from env or the stored config', () => {
    expect(
      resolveLlmRuntimeSettings({
        providerKey: 'openrouter',
        env: { LLM_PROVIDER: 'openrouter', LLM_SUPPORTS_STRUCTURED_OUTPUTS: 'true' },
      }).supportsStructuredOutputs,
    ).toBe(true);
    expect(
      resolveLlmRuntimeSettings({
        providerKey: 'openrouter',
        storedConfig: { supportsStructuredOutputs: true },
        env: {},
      }).supportsStructuredOutputs,
    ).toBe(true);
  });

  it('lets an explicit env "false" override a stored true (env wins, tri-state)', () => {
    expect(
      resolveLlmRuntimeSettings({
        providerKey: 'openrouter',
        storedConfig: { supportsStructuredOutputs: true },
        env: { LLM_PROVIDER: 'openrouter', LLM_SUPPORTS_STRUCTURED_OUTPUTS: 'false' },
      }).supportsStructuredOutputs,
    ).toBe(false);
  });

  it('resolves the request timeout from env (LLM_REQUEST_TIMEOUT_MS) or stored config', () => {
    expect(
      resolveLlmRuntimeSettings({
        providerKey: 'openrouter',
        storedConfig: { requestTimeoutMs: 45_000 },
        env: { LLM_PROVIDER: 'openrouter', LLM_REQUEST_TIMEOUT_MS: '90000' },
      }).requestTimeoutMs,
    ).toBe(90_000); // env wins
    expect(
      resolveLlmRuntimeSettings({
        providerKey: 'openrouter',
        storedConfig: { requestTimeoutMs: 45_000 },
        env: {},
      }).requestTimeoutMs,
    ).toBe(45_000); // stored fills the gap
  });

  it('omits a malformed or non-positive timeout (provider default applies)', () => {
    for (const value of ['', 'abc', '0', '-5', 'NaN']) {
      expect(
        resolveLlmRuntimeSettings({
          providerKey: 'openrouter',
          env: { LLM_PROVIDER: 'openrouter', LLM_REQUEST_TIMEOUT_MS: value },
        }).requestTimeoutMs,
      ).toBeUndefined();
    }
    expect(
      resolveLlmRuntimeSettings({
        providerKey: 'openrouter',
        storedConfig: { requestTimeoutMs: 'soon' },
        env: {},
      }).requestTimeoutMs,
    ).toBeUndefined();
  });

  it('treats a blank or unknown structured-outputs env value as unset (DB fills)', () => {
    for (const value of ['', '  ', 'yes', '1']) {
      expect(
        resolveLlmRuntimeSettings({
          providerKey: 'openrouter',
          storedConfig: { supportsStructuredOutputs: true },
          env: { LLM_PROVIDER: 'openrouter', LLM_SUPPORTS_STRUCTURED_OUTPUTS: value },
        }).supportsStructuredOutputs,
      ).toBe(true);
    }
  });

  it('is empty-model with no baseUrl key when nothing configures the LLM', () => {
    const settings = resolveLlmRuntimeSettings({ providerKey: 'openrouter', env: {} });
    expect(settings).toEqual({ model: '', supportsStructuredOutputs: false });
  });

  it('resolves the reasoning effort from env (LLM_REASONING_EFFORT) or stored config', () => {
    expect(
      resolveLlmRuntimeSettings({
        providerKey: 'openai',
        storedConfig: { reasoningEffort: 'high' },
        env: { LLM_PROVIDER: 'openai', LLM_REASONING_EFFORT: 'low' },
      }).reasoningEffort,
    ).toBe('low'); // env wins
    expect(
      resolveLlmRuntimeSettings({
        providerKey: 'openai',
        storedConfig: { reasoningEffort: 'high' },
        env: {},
      }).reasoningEffort,
    ).toBe('high'); // stored fills the gap
  });

  it('accepts every OpenAI effort value, including none/xhigh/max', () => {
    for (const value of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(
        resolveLlmRuntimeSettings({
          providerKey: 'openai',
          env: { LLM_PROVIDER: 'openai', LLM_REASONING_EFFORT: value },
        }).reasoningEffort,
      ).toBe(value);
    }
  });

  it('omits a blank or unknown reasoning effort (the preset default applies)', () => {
    for (const value of ['', '  ', 'ultra', '5']) {
      expect(
        resolveLlmRuntimeSettings({
          providerKey: 'openai',
          env: { LLM_PROVIDER: 'openai', LLM_REASONING_EFFORT: value },
        }).reasoningEffort,
      ).toBeUndefined();
    }
    expect(
      resolveLlmRuntimeSettings({
        providerKey: 'openai',
        storedConfig: { reasoningEffort: 'extreme' },
        env: {},
      }).reasoningEffort,
    ).toBeUndefined();
  });

  it('normalizes reasoning-effort case (the API expects lowercase values)', () => {
    expect(
      resolveLlmRuntimeSettings({
        providerKey: 'openai',
        env: { LLM_PROVIDER: 'openai', LLM_REASONING_EFFORT: ' Medium ' },
      }).reasoningEffort,
    ).toBe('medium');
  });
});

describe('image model (IMAGE_MODEL wins, the model saved with the key fills the gap)', () => {
  const imageModel = (env: NodeJS.ProcessEnv, config: Record<string, unknown> | null) =>
    resolveProviderSettings('image', 'openrouter', config, env).model;

  it('lets IMAGE_MODEL win over the saved model', () => {
    expect(imageModel({ IMAGE_MODEL: ' env/model ' }, { model: 'saved/model' })).toBe('env/model');
  });

  it('uses the saved model when IMAGE_MODEL is blank or unset', () => {
    expect(imageModel({ IMAGE_MODEL: '  ' }, { model: ' saved/model ' })).toBe('saved/model');
    expect(imageModel({}, { model: 'saved/model' })).toBe('saved/model');
  });

  it('leaves the model to the adapter default when neither sets one', () => {
    expect(imageModel({}, null)).toBeUndefined();
    expect(imageModel({}, { model: ' ' })).toBeUndefined();
  });
});

describe('resolveCredentialSource (env overrides, DB fills gaps)', () => {
  it('prefers env when both env and DB are present', () => {
    expect(resolveCredentialSource('sk-env', true)).toBe('env');
  });

  it('uses env when only env is present', () => {
    expect(resolveCredentialSource('sk-env', false)).toBe('env');
  });

  it('falls back to the database when env is absent', () => {
    expect(resolveCredentialSource(undefined, true)).toBe('database');
  });

  it('is unconfigured when neither is present', () => {
    expect(resolveCredentialSource(undefined, false)).toBeNull();
  });
});
