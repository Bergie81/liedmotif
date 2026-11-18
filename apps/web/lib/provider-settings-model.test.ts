import { describe, expect, it } from 'vitest';
import type { CredentialStatus } from '@liedmotif/db';
import {
  COVER_KEY_NOTICE,
  coverAccountAlert,
  coverKeyNotice,
  coverSharedKeyVendor,
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
    // IMAGE_PROVIDER named without a key anywhere (no row saved in the app) is
    // the optional provider left off.
    expect(
      generatedImageProviderPresentation({
        credential: status({ configured: false, source: null, masked: null, displayName: null }),
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

  it('presents Cover images sharing the Text AI key, and a saved provider with no key', () => {
    const status = (over: Partial<CredentialStatus>): CredentialStatus => ({
      providerType: 'image',
      providerKey: 'openai',
      displayName: 'openai',
      configured: true,
      source: 'shared',
      masked: '••••9876',
      config: null,
      lastValidatedAt: null,
      validationStatus: null,
      decryptError: false,
      ...over,
    });

    expect(generatedImageProviderPresentation({ credential: status({}), model: null })).toEqual({
      name: 'OpenAI',
      configured: true,
      source: 'Shared OpenAI key',
      model: null,
      status: { label: 'Configured', tone: 'ok' },
    });
    expect(
      generatedImageProviderPresentation({
        credential: status({ configured: false, source: null, masked: null }),
        model: null,
      }),
    ).toEqual({
      name: 'OpenAI',
      configured: false,
      source: null,
      model: null,
      status: { label: 'Needs a key', tone: 'warn' },
    });
  });

  it('warns on the Text AI card only while Cover images share its key', () => {
    expect(COVER_KEY_NOTICE).toBe(
      'Cover images use this key too. Changing the provider or removing this key turns Tailored Cover Art off until Cover images has its own key.',
    );
    expect(coverKeyNotice({ source: 'shared' })).toBe(COVER_KEY_NOTICE);
    // A mixed setup on separate keys, or no Cover provider at all.
    expect(coverKeyNotice({ source: 'database' })).toBeNull();
    expect(coverKeyNotice({ source: 'env' })).toBeNull();
    expect(coverKeyNotice(null)).toBeNull();
  });

  it('offers the shared Text AI key only where a Cover key from .env does not win', () => {
    expect(coverSharedKeyVendor({ source: 'database' }, 'openai')).toBe('openai');
    expect(coverSharedKeyVendor({ source: 'shared' }, 'openai')).toBe('openai');
    expect(coverSharedKeyVendor(null, 'gemini')).toBe('gemini');
    expect(coverSharedKeyVendor({ source: 'env' }, 'openai')).toBeNull();
    expect(coverSharedKeyVendor({ source: 'database' }, null)).toBeNull();
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

describe('the Cover images account alert', () => {
  const refusedAt = new Date('2026-11-18T10:00:00.000Z');
  const before = new Date('2026-11-18T09:00:00.000Z');
  const after = new Date('2026-11-18T11:00:00.000Z');

  it.each([
    ['gemini', 'Google needs billing turned on for image models.'],
    ['openai', 'OpenAI needs your organisation verified for image models.'],
  ])(
    'names the cause while the newest %s Cover was refused for the account',
    (providerKey, text) => {
      expect(
        coverAccountAlert({
          outcome: { providerKey, accountNotReady: true, settledAt: refusedAt },
          credentialsSavedAt: [before],
        }),
      ).toBe(text);
    },
  );

  it('clears once a later Cover landed', () => {
    expect(
      coverAccountAlert({
        outcome: { providerKey: 'gemini', accountNotReady: false, settledAt: after },
        credentialsSavedAt: [before],
      }),
    ).toBeNull();
  });

  it('clears once any credential supplying the Cover key was saved after the refusal', () => {
    expect(
      coverAccountAlert({
        outcome: { providerKey: 'openai', accountNotReady: true, settledAt: refusedAt },
        credentialsSavedAt: [before, after],
      }),
    ).toBeNull();
  });

  it('stays while the credential is only in the environment', () => {
    expect(
      coverAccountAlert({
        outcome: { providerKey: 'openai', accountNotReady: true, settledAt: refusedAt },
        credentialsSavedAt: [null],
      }),
    ).toBe('OpenAI needs your organisation verified for image models.');
  });

  it('shows nothing before any Cover settled', () => {
    expect(coverAccountAlert({ outcome: null, credentialsSavedAt: [] })).toBeNull();
  });
});
