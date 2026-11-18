import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OnboardingCoversStep } from './onboarding-covers-step';
import type { OnboardingCredential } from '@/lib/onboarding-data';
import type { CoverBudget } from './onboarding-limits-model';

const noop = () => {};
const openRouter: OnboardingCredential = {
  providerKey: 'openrouter',
  displayName: 'OpenRouter',
  environmentManaged: false,
  configured: false,
  masked: null,
};

function renderCovers({
  imageConnected = true,
  credential = { ...openRouter, configured: imageConnected },
  imageModel = credential.model ?? '',
  musicProviderCoverConfigured = false,
  ...budget
}: Partial<CoverBudget> & {
  imageConnected?: boolean;
  credential?: OnboardingCredential;
  imageModel?: string;
  musicProviderCoverConfigured?: boolean;
}) {
  return renderToStaticMarkup(
    React.createElement(OnboardingCoversStep, {
      budget: {
        tailoredCoverArtEnabled: true,
        ceilingEnabled: false,
        coversPerDay: '25',
        coversPerMonth: '300',
        ...budget,
      },
      credential,
      imageConnected,
      imageModel,
      encryptionKeyConfigured: true,
      musicProviderCoverConfigured,
      onChange: noop,
      onConnected: noop,
      onDone: noop,
    }),
  );
}

describe('onboarding covers step image key', () => {
  beforeAll(() => vi.stubGlobal('React', React));
  afterAll(() => vi.unstubAllGlobals());

  it('asks for the image key once Tailored Cover Art is chosen', () => {
    expect(renderCovers({ imageConnected: false })).toContain('OpenRouter API key');
    expect(renderCovers({ imageConnected: false, tailoredCoverArtEnabled: false })).not.toContain(
      'OpenRouter API key',
    );
  });

  it('asks a new install for an OpenAI key, without the OpenRouter guide', () => {
    const markup = renderCovers({
      imageConnected: false,
      credential: { ...openRouter, providerKey: 'openai', displayName: 'OpenAI' },
    });
    expect(markup).toContain('OpenAI API key');
    expect(markup).not.toContain('Where do I get an OpenRouter key?');
    expect(renderCovers({ imageConnected: false })).toContain('Where do I get an OpenRouter key?');
  });

  it('offers the image model prefilled, and locks it while IMAGE_MODEL sets it', () => {
    const editable = renderCovers({
      imageConnected: false,
      credential: { ...openRouter, model: 'google/gemini-3.1-flash-image' },
    });
    expect(editable).toContain('value="google/gemini-3.1-flash-image"');
    expect(editable).not.toContain('IMAGE_MODEL');

    const locked = renderCovers({
      imageConnected: false,
      credential: { ...openRouter, model: 'env/model', modelEnvironmentManaged: true },
    });
    expect(locked).toContain('value="env/model"');
    expect(locked).toContain('IMAGE_MODEL');
    expect(locked).toMatch(
      /<input[^>]*value="env\/model"[^>]*readonly|<input[^>]*readonly[^>]*value="env\/model"/i,
    );
  });

  // The flow loads once, so a key saved on this step is newer than `credential`.
  it('shows the model saved on this step when the step is revisited', () => {
    const markup = renderCovers({
      imageConnected: true,
      credential: { ...openRouter, configured: false, model: 'loaded/model' },
      imageModel: 'saved/model',
    });
    expect(markup).toContain('value="saved/model"');
    expect(markup).not.toContain('loaded/model');
  });

  it('reports an image key from .env instead of asking for one', () => {
    const markup = renderCovers({
      credential: { ...openRouter, configured: true, environmentManaged: true },
    });
    expect(markup).toContain('IMAGE_API_KEY');
    expect(markup).not.toContain('OpenRouter API key');
  });
});

describe('onboarding covers step budget note', () => {
  beforeAll(() => vi.stubGlobal('React', React));
  afterAll(() => vi.unstubAllGlobals());

  // The caps only bind painted Covers; with nothing painting, a daily cap and a
  // dollar ceiling would be promised that the Admin is not under.
  it('states no Cover cap or cost while the image model does not paint', () => {
    for (const markup of [
      renderCovers({ imageConnected: false, ceilingEnabled: true }),
      renderCovers({ imageConnected: false, musicProviderCoverConfigured: true }),
      renderCovers({ tailoredCoverArtEnabled: false, ceilingEnabled: true }),
    ]) {
      expect(markup).not.toContain('Covers a day');
      expect(markup).not.toContain('No cap on your own Covers');
    }
  });

  it('explains the uncapped spend while painting with the ceiling off', () => {
    const markup = renderCovers({ ceilingEnabled: false });

    expect(markup).toContain('No cap on your own Covers');
    expect(markup).not.toContain('Covers a day');
  });

  it('prices the daily cap while painting with the ceiling on', () => {
    expect(renderCovers({ ceilingEnabled: true })).toContain('25 Covers a day');
  });
});

describe('onboarding covers step price', () => {
  beforeAll(() => vi.stubGlobal('React', React));
  afterAll(() => vi.unstubAllGlobals());

  const gemini = { ...openRouter, providerKey: 'gemini', displayName: 'Gemini' };

  it("states the selected provider's price per Cover on the switch", () => {
    expect(renderCovers({ credential: gemini })).toContain('about 4 cents a Cover');
    expect(renderCovers({ imageConnected: false, credential: gemini })).toContain(
      'about 4 cents a Cover',
    );
    expect(renderCovers({})).toContain('about 7 cents a Cover');
  });

  it("prices the Cover budget note at the selected provider's price", () => {
    expect(renderCovers({ credential: gemini, ceilingEnabled: false })).toMatch(
      /at about <span[^>]*>4 cents<\/span> each/,
    );
    expect(renderCovers({ credential: gemini, ceilingEnabled: true })).toContain('$1.00 a day');
    expect(
      renderCovers({
        credential: { ...openRouter, providerKey: 'openai', displayName: 'OpenAI' },
        ceilingEnabled: true,
      }),
    ).toContain('$1.50 a day');
  });
});
