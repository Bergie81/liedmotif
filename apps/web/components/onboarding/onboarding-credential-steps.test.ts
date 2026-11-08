import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OnboardingCredential } from '@/lib/onboarding-data';
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

  it('always offers a way past, because the LLM is optional', () => {
    const markup = renderLlm(openRouter);

    expect(markup).toContain('Skip for now');
    expect(markup).toContain('Save and continue');
  });

  it('offers every text-LLM preset, with the resolved one selected', () => {
    const markup = renderLlm(openRouter);

    for (const label of ['OpenAI', 'OpenRouter', 'OpenAI-compatible', 'Ollama']) {
      expect(markup).toContain(label);
    }
    expect(markup).toMatch(/data-state="active"[^>]*>OpenRouter/);
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
