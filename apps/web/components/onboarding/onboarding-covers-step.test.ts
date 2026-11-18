// @vitest-environment jsdom

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { toast } from '@/lib/toast';
import { OnboardingCoversStep } from './onboarding-covers-step';
import type { OnboardingImageCredential } from '@/lib/onboarding-data';
import type { CoverBudget } from './onboarding-limits-model';

const noop = () => {};
const openRouter: OnboardingImageCredential = {
  providerKey: 'openrouter',
  displayName: 'OpenRouter',
  environmentManaged: false,
  configured: false,
  masked: null,
  sharesKey: false,
};

interface CoversOptions extends Partial<CoverBudget> {
  imageConnected?: boolean;
  credential?: OnboardingImageCredential;
  /** The Cover provider stored, set in `.env` or saved on the step; `null` when none is. */
  imageProviderKey?: string | null;
  imageModel?: string;
  sharedKeyVendor?: string | null;
  musicProviderCoverConfigured?: boolean;
  onDone?: () => void;
}

function coversStep({
  imageConnected = true,
  credential = { ...openRouter, configured: imageConnected },
  imageProviderKey = credential.providerKey,
  imageModel = credential.model ?? '',
  sharedKeyVendor = null,
  musicProviderCoverConfigured = false,
  onDone = noop,
  ...budget
}: CoversOptions) {
  return React.createElement(OnboardingCoversStep, {
    budget: {
      tailoredCoverArtEnabled: true,
      ceilingEnabled: false,
      coversPerDay: '25',
      coversPerMonth: '300',
      ...budget,
    },
    credential,
    imageProviderKey,
    imageConnected,
    imageModel,
    sharedKeyVendor,
    encryptionKeyConfigured: true,
    musicProviderCoverConfigured,
    onChange: noop,
    onConnected: noop,
    onDone,
  });
}

function renderCovers(options: CoversOptions) {
  return renderToStaticMarkup(coversStep(options));
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

describe('onboarding covers step provider', () => {
  afterEach(() => {
    cleanup();
    toast.dismiss();
    vi.unstubAllGlobals();
  });

  /** A fresh install: no Cover provider stored, the Text AI as given. */
  const fresh = (options: CoversOptions = {}) =>
    render(
      coversStep({
        imageConnected: false,
        imageProviderKey: null,
        credential: { ...openRouter, providerKey: 'openai', displayName: 'OpenAI' },
        ...options,
      }),
    );
  const keyField = () => screen.queryByPlaceholderText('sk-…');
  const active = () => screen.getByRole('button', { pressed: true }).textContent;
  const pick = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

  it('offers OpenAI and Gemini, OpenRouter behind More options, and the model, whatever the Text AI', () => {
    fresh({ sharedKeyVendor: null });

    expect(screen.getByRole('button', { name: 'OpenAI' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Gemini' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'OpenRouter' })).toBeNull();
    pick('More options');
    expect(screen.getByRole('button', { name: 'OpenRouter' })).toBeTruthy();
    expect(screen.getByText('Model')).toBeTruthy();
  });

  it('opens on a Cover provider already chosen, else the Text AI vendor whose key can paint, else OpenAI', () => {
    fresh({ imageProviderKey: 'openrouter', sharedKeyVendor: 'gemini' });
    expect(active()).toBe('OpenRouter');
    cleanup();

    fresh({ sharedKeyVendor: 'gemini' });
    expect(active()).toBe('Gemini');
    cleanup();

    fresh({ sharedKeyVendor: null });
    expect(active()).toBe('OpenAI');
  });

  it("uses the Text AI's key on the same vendor, with no key field", () => {
    fresh({ sharedKeyVendor: 'openai' });

    expect(screen.getByText('Uses your OpenAI key')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use a separate key' })).toBeTruthy();
    expect(keyField()).toBeNull();
    expect(screen.queryByText('Where do I get an OpenAI key?')).toBeNull();
  });

  it('asks for the Gemini key beside an OpenAI Text AI, and stops asking on OpenAI again', () => {
    fresh({ sharedKeyVendor: 'openai' });

    pick('Gemini');
    expect(keyField()).toBeTruthy();
    expect(screen.getByText('Where do I get a Gemini key?')).toBeTruthy();
    expect(screen.queryByText(/Uses your/)).toBeNull();

    pick('OpenAI');
    expect(keyField()).toBeNull();
    expect(screen.getByText('Uses your OpenAI key')).toBeTruthy();
  });

  it('asks for the OpenAI key beside a Gemini Text AI, and stops asking on Gemini again', () => {
    fresh({ sharedKeyVendor: 'gemini' });
    expect(keyField()).toBeNull();

    pick('OpenAI');
    expect(keyField()).toBeTruthy();
    expect(screen.getByText('Where do I get an OpenAI key?')).toBeTruthy();

    pick('Gemini');
    expect(keyField()).toBeNull();
    expect(screen.getByText('Uses your Gemini key')).toBeTruthy();
  });

  // No Text AI, or one on Ollama or an OpenAI-compatible service: no shared key resolves.
  it('asks for a key when no Text AI key can be shared', () => {
    fresh({ sharedKeyVendor: null });

    expect(keyField()).toBeTruthy();
    expect(screen.getByText('Where do I get an OpenAI key?')).toBeTruthy();
    expect(screen.queryByText(/Uses your/)).toBeNull();
  });

  it('shows no OpenRouter note about reusing the Text AI key', () => {
    fresh({ imageProviderKey: 'openrouter', sharedKeyVendor: null });

    expect(screen.getByText('Where do I get an OpenRouter key?')).toBeTruthy();
    expect(screen.queryByText(/same key works here/)).toBeNull();
  });

  // "Leave blank to keep" promises a key the selected provider keeps of its own.
  it('offers no stored key to keep for a separate key beside a shared one', () => {
    fresh({
      imageConnected: true,
      imageProviderKey: 'openai',
      sharedKeyVendor: 'openai',
      credential: {
        ...openRouter,
        providerKey: 'openai',
        displayName: 'OpenAI',
        configured: true,
        masked: 'sk-…abcd',
        sharesKey: true,
      },
    });

    pick('Use a separate key');
    expect(keyField()).toBeTruthy();
    expect(screen.queryByText('LEAVE BLANK TO KEEP')).toBeNull();
  });

  it('offers the stored key to keep only on the provider that keeps it', () => {
    fresh({
      imageConnected: true,
      imageProviderKey: 'openai',
      credential: {
        ...openRouter,
        providerKey: 'openai',
        displayName: 'OpenAI',
        configured: true,
        masked: 'sk-…abcd',
      },
    });
    expect(screen.getByText('LEAVE BLANK TO KEEP')).toBeTruthy();

    pick('Gemini');
    expect(screen.queryByText('LEAVE BLANK TO KEEP')).toBeNull();
  });

  it('names the selected vendor and its price on the switch', () => {
    fresh({ sharedKeyVendor: 'openai' });
    expect(screen.getByText('Uses OpenAI · about 6 cents a Cover')).toBeTruthy();

    pick('Gemini');
    expect(screen.getByText('Uses Gemini · about 4 cents a Cover')).toBeTruthy();
  });

  it('asks for no key while the switch is off, even with a shared key', () => {
    fresh({ sharedKeyVendor: 'openai', tailoredCoverArtEnabled: false });

    expect(keyField()).toBeNull();
    expect(screen.queryByText(/Uses your/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Gemini' })).toBeNull();
  });

  it('saves the shared key by reference, then the Cover budget', async () => {
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        sent.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return Response.json({ ok: true, limits: {} });
      }),
    );
    const onDone = vi.fn();
    fresh({ sharedKeyVendor: 'gemini', onDone });

    pick('Save and continue');
    await waitFor(() => expect(onDone).toHaveBeenCalled());

    expect(sent[0]).toMatchObject({
      url: '/api/settings/credentials',
      body: { providerType: 'image', providerKey: 'gemini', shareTextLlmKey: true },
    });
    expect(sent[0]!.body.secret).toBeUndefined();
    expect(sent[1]).toMatchObject({
      url: '/api/settings/limits',
      body: { tailoredCoverArtEnabled: true },
    });
  });

  it('saves only the budget with the switch off, even with a shared key', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return Response.json({ ok: true, limits: {} });
      }),
    );
    const onDone = vi.fn();
    fresh({ sharedKeyVendor: 'gemini', tailoredCoverArtEnabled: false, onDone });

    pick('Save and continue');
    await waitFor(() => expect(onDone).toHaveBeenCalled());

    expect(urls).toEqual(['/api/settings/limits']);
  });
});
