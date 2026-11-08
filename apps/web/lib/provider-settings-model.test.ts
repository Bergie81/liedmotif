import { describe, expect, it } from 'vitest';
import type { CredentialStatus } from '@liedmotif/db';
import {
  generatedImageProviderPresentation,
  llmProviderPresentation,
  requiresProviderReplacementConfirmation,
} from './provider-settings-model';

describe('provider settings model', () => {
  it('presents the cover-image provider by where its key resolves from', () => {
    const status = (over: Partial<CredentialStatus>): CredentialStatus => ({
      providerType: 'image',
      providerKey: 'openrouter',
      displayName: 'OpenRouter',
      configured: true,
      source: 'database',
      masked: '••••1234',
      config: null,
      lastValidatedAt: null,
      validationStatus: null,
      decryptError: false,
      ...over,
    });
    const notConfigured = {
      name: 'Not configured',
      configured: false,
      source: null,
      status: { label: 'Unavailable', tone: 'muted' },
    };

    expect(generatedImageProviderPresentation({ credential: null, model: null })).toMatchObject(
      notConfigured,
    );
    // IMAGE_PROVIDER named without a key anywhere is the optional provider left off.
    expect(
      generatedImageProviderPresentation({
        credential: status({ configured: false, source: null, masked: null }),
        model: null,
      }),
    ).toMatchObject(notConfigured);
    expect(generatedImageProviderPresentation({ credential: status({}), model: null })).toEqual({
      name: 'OpenRouter',
      configured: true,
      source: 'Database',
      model: null,
      status: { label: 'Configured', tone: 'ok' },
    });
    expect(
      generatedImageProviderPresentation({
        credential: status({ source: 'env' }),
        model: 'image/model',
      }),
    ).toEqual({
      name: 'OpenRouter',
      configured: true,
      source: 'Environment',
      model: 'image/model',
      status: { label: 'Environment', tone: 'ok' },
    });
    expect(
      generatedImageProviderPresentation({
        credential: status({ masked: null, decryptError: true }),
        model: null,
      }),
    ).toMatchObject({ configured: false, status: { label: 'Unhealthy', tone: 'warn' } });
  });

  it('recognizes a keyless Ollama configuration independently of credential source', () => {
    expect(
      llmProviderPresentation({
        selected: true,
        supported: true,
        configurationSource: 'database',
        credentialSource: null,
        decryptError: false,
        validationStatus: null,
        needsKey: false,
        needsBaseUrl: true,
        baseUrl: 'http://localhost:11434',
        model: 'llama3',
        defaultModel: undefined,
      }),
    ).toEqual({
      configured: true,
      source: 'Database',
      status: { label: 'Configured', tone: 'ok' },
    });
  });

  it('distinguishes absent and incomplete LLM configurations', () => {
    const base = {
      supported: true,
      credentialSource: null,
      decryptError: false,
      validationStatus: null,
      needsKey: true,
      needsBaseUrl: false,
      baseUrl: undefined,
      model: 'model',
      defaultModel: undefined,
    } as const;
    expect(
      llmProviderPresentation({ ...base, selected: false, configurationSource: null }),
    ).toEqual({
      configured: false,
      source: null,
      status: { label: 'Unavailable', tone: 'muted' },
    });
    expect(
      llmProviderPresentation({ ...base, selected: true, configurationSource: 'environment' }),
    ).toEqual({
      configured: false,
      source: 'Environment',
      status: { label: 'Unhealthy', tone: 'warn' },
    });
  });

  it('marks an unsupported selected provider unhealthy', () => {
    expect(
      llmProviderPresentation({
        selected: true,
        supported: false,
        configurationSource: 'environment',
        credentialSource: 'env',
        decryptError: false,
        validationStatus: null,
        needsKey: true,
        needsBaseUrl: false,
        model: 'model',
      }),
    ).toEqual({
      configured: false,
      source: 'Environment',
      status: { label: 'Unhealthy', tone: 'warn' },
    });
  });

  it('confirms a configured provider replacement but not an initial selection', () => {
    expect(
      requiresProviderReplacementConfirmation({
        configured: true,
        initialProviderKey: 'openai',
        nextProviderKey: 'openrouter',
      }),
    ).toBe(true);
    expect(
      requiresProviderReplacementConfirmation({
        configured: false,
        initialProviderKey: 'openai',
        nextProviderKey: 'openrouter',
      }),
    ).toBe(false);
    expect(
      requiresProviderReplacementConfirmation({
        configured: true,
        initialProviderKey: 'openai',
        nextProviderKey: 'openai',
      }),
    ).toBe(false);
  });
});
