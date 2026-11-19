import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OnboardingCredential } from '@/lib/onboarding/onboarding-data';
import { OnboardingLlmStep } from './onboarding-llm-step';
import { OnboardingMusicStep } from './onboarding-music-step';

function music(overrides: Partial<OnboardingCredential> = {}): OnboardingCredential {
  return {
    providerKey: 'suno',
    displayName: 'Suno',
    environmentManaged: false,
    configured: false,
    masked: null,
    ...overrides,
  };
}

const noop = () => {};

function renderMusic(credential: OnboardingCredential, encryptionKeyConfigured = true) {
  return renderToStaticMarkup(
    React.createElement(OnboardingMusicStep, {
      credential,
      encryptionKeyConfigured,
      onConnected: noop,
      onDone: noop,
    }),
  );
}

describe('onboarding music step', () => {
  beforeAll(() => vi.stubGlobal('React', React));
  afterAll(() => vi.unstubAllGlobals());

  it('offers a key field and blocks the way past until a typed key is proven', () => {
    const markup = renderMusic(music());

    expect(markup).toContain('type="password"');
    expect(markup).toContain('Test the key');
    // Nothing is resolvable yet, so the only way forward is disabled.
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Continue<\/button>/);
  });

  it('names the environment variable and drops the field when the key is from .env', () => {
    const markup = renderMusic(
      music({ environmentManaged: true, configured: true, masked: '••••1234' }),
    );

    expect(markup).toContain('SUNO_API_KEY');
    expect(markup).toContain('The music model is already set up');
    expect(markup).toContain('Test the configured key');
    // A key typed here could never win over env, so there is nothing to type into.
    expect(markup).not.toContain('type="password"');
  });

  it('lets an already-stored key past without re-testing it', () => {
    const markup = renderMusic(music({ configured: true, masked: '••••1234' }));

    expect(markup).toContain('type="password"');
    expect(markup).toContain('LEAVE BLANK TO KEEP');
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Continue<\/button>/);
  });

  it('keeps the optional endpoint out of the way of a screen that gates the flow', () => {
    const markup = renderMusic(music());

    expect(markup).toContain('Use a different endpoint');
    // Inside the disclosure, not standing beside the key field.
    expect(markup).toMatch(/<details[\s\S]*Base URL[\s\S]*<\/details>/);
  });

  it('explains the missing encryption key rather than offering an unstorable field', () => {
    const markup = renderMusic(music(), false);

    expect(markup).toContain('CREDENTIAL_ENCRYPTION_KEY');
  });
});

describe('onboarding text-LLM step', () => {
  beforeAll(() => vi.stubGlobal('React', React));
  afterAll(() => vi.unstubAllGlobals());

  function renderLlm(credential: OnboardingCredential) {
    return renderToStaticMarkup(
      React.createElement(OnboardingLlmStep, {
        credential,
        encryptionKeyConfigured: true,
        onConnected: noop,
        onDone: noop,
      }),
    );
  }

  const openRouter: OnboardingCredential = {
    providerKey: 'openrouter',
    displayName: 'OpenRouter',
    environmentManaged: false,
    configured: false,
    masked: null,
  };

  it('locks a model .env sets and names its variable, leaving the key field open', () => {
    const markup = renderLlm({
      ...openRouter,
      model: 'env/model',
      envLocks: { openrouter: { model: { variable: 'LLM_MODEL', value: 'env/model' } } },
    });

    expect(markup).toContain('SET BY LLM_MODEL');
    expect(markup).toMatch(/<input[^>]*readOnly=""[^>]*value="env\/model"/);
    expect(markup).toContain('type="password"');
    expect(markup).not.toContain('LLM_API_KEY');
  });

  it('locks the provider picker while LLM_PROVIDER sets it, and still asks for the key', () => {
    const markup = renderLlm({
      ...openRouter,
      providerKey: 'gemini',
      displayName: 'Gemini',
      providerEnvironmentManaged: true,
    });

    expect(markup).toContain('SET IN .env (LLM_PROVIDER)');
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>OpenAI<\/button>/);
    expect(markup).not.toContain('More options');
    expect(markup).toContain('Gemini API key');
    expect(markup).toContain('type="password"');
    expect(renderLlm(openRouter)).not.toContain('SET IN .env');
  });

  it('always offers a way past, because the LLM is optional', () => {
    const markup = renderLlm(openRouter);

    expect(markup).toContain('Skip for now');
    expect(markup).toContain('Save and continue');
  });

  const providerButtons = (markup: string) =>
    [...markup.matchAll(/data-state="(?:active|inactive)"[^>]*>([^<]+)<\/button>/g)].map(
      (match) => match[1],
    );

  it('starts a new install on OpenAI, with the advanced presets behind More options', () => {
    const markup = renderLlm({ ...openRouter, providerKey: 'openai', displayName: 'OpenAI' });

    expect(providerButtons(markup)).toEqual(['OpenAI', 'Gemini', 'Ollama']);
    expect(markup).toMatch(/data-state="active"[^>]*>OpenAI</);
    expect(markup).toMatch(/<button[^>]*>More options<\/button>/);
  });

  it('shows and selects a stored preset that sits behind More options', () => {
    const markup = renderLlm(openRouter);

    expect(providerButtons(markup)).toEqual([
      'OpenAI',
      'Gemini',
      'Ollama',
      'OpenRouter',
      'OpenAI-compatible',
    ]);
    expect(markup).toMatch(/data-state="active"[^>]*>OpenRouter</);
    expect(markup).not.toContain('More options');
  });

  it('explains where to get a Gemini key when Gemini is selected', () => {
    const gemini = renderLlm({ ...openRouter, providerKey: 'gemini', displayName: 'Gemini' });
    expect(gemini).toMatch(/data-state="active"[^>]*>Gemini</);
    expect(gemini).toContain('Where do I get a Gemini key?');
    expect(gemini).toContain('aistudio.google.com');

    const openAi = renderLlm({ ...openRouter, providerKey: 'openai', displayName: 'OpenAI' });
    expect(openAi).not.toContain('Gemini key');
  });

  it('explains where to get an OpenAI key when OpenAI is selected', () => {
    const openAi = renderLlm({ ...openRouter, providerKey: 'openai', displayName: 'OpenAI' });
    expect(openAi).toContain('Where do I get an OpenAI key?');
    expect(openAi).toContain('platform.openai.com/api-keys');

    expect(renderLlm(openRouter)).not.toContain('OpenAI key?');
  });

  it("states the selected option's cost under the picker", () => {
    expect(renderLlm({ ...openRouter, providerKey: 'openai', displayName: 'OpenAI' })).toContain(
      'Under 1 cent per Session. This key can also paint your Covers, about 6 cents each.',
    );
    expect(renderLlm({ ...openRouter, providerKey: 'gemini', displayName: 'Gemini' })).toContain(
      'Covers need billing turned on at Google.',
    );
    expect(renderLlm({ ...openRouter, providerKey: 'ollama', displayName: 'Ollama' })).toContain(
      'Free, runs on your machine. It cannot paint Covers.',
    );
    expect(renderLlm(openRouter)).toContain('Cost depends on the model.');
    expect(
      renderLlm({
        ...openRouter,
        providerKey: 'openai-compatible',
        displayName: 'OpenAI-compatible',
      }),
    ).toContain('Cost depends on your service. It cannot paint Covers.');
  });

  it('reports the environment as the source and offers no skip it cannot honour', () => {
    const markup = renderLlm({ ...openRouter, environmentManaged: true, configured: true });

    expect(markup).toContain('LLM_API_KEY');
    expect(markup).toContain('LLM_PROVIDER');
    expect(markup).not.toContain('Skip for now');
  });

  it('never offers to "skip" a key that is already stored — skipping only declines a new one', () => {
    const markup = renderLlm({ ...openRouter, configured: true });

    expect(markup).toContain('Leave it as it is');
    expect(markup).not.toContain('Skip for now');
  });
});
