// @vitest-environment jsdom

// Saving in Settings never moves the form: what a save did is a toast. A
// failure is an error that the next save of the same form replaces, so a
// successful retry leaves only its success on screen. A hint that describes
// the page, not a result, stays where it is.

import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CoverArtSettings } from '@liedmotif/db';
import { DEFAULT_GENERATION_SETTINGS, DEFAULT_PLAYBACK_SETTINGS } from '@liedmotif/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '@/lib/api-client';
import { shownToasts, toast } from '@/lib/toast';

const COVER_ART: CoverArtSettings = {
  defaultStyle: 'auto',
  customStyleDefinition: '',
  useStandardCoverArt: false,
  promptEnhancementEnabled: true,
};

const api = vi.hoisted(() => ({
  updatePlaybackSettings: vi.fn(),
  updateGenerationSettings: vi.fn(),
  savePersonalization: vi.fn(),
  resetLearnedTaste: vi.fn(),
}));
vi.mock('@/lib/api-client', () => api);
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('@/components/player/player-provider', () => ({
  usePlayerContext: () => ({}),
  adoptStoredPlaybackSettings: () => {},
}));

const { PlaybackForm } = await import('./playback-form');
const { GenerationForm } = await import('./generation-form');
const { LanguageForm } = await import('./language-form');
const { CostsPanel, UNIT_COSTS_HINT } = await import('./costs-panel');
const { CoverArtForm } = await import('./cover-art-form');
const { PersonalizationSection } = await import('./personalization-section');

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  // The Radix slider measures itself.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  toast.dismiss();
});

function failed(message: string): ApiResult<never> {
  return { ok: false, error: { code: 'internal_error', message, retryable: false } };
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

async function expectToasts(...expected: { tone: string; message: string }[]) {
  await waitFor(() =>
    expect(shownToasts()).toEqual(expected.map((each) => expect.objectContaining(each))),
  );
}

/** Saves once into `failure`, then again into the success that clears it. */
async function failThenSucceed(save: string, failure: string, success: string) {
  fireEvent.click(button(save));
  await expectToasts({ tone: 'error', message: failure });
  await waitFor(() => expect(button(save).disabled).toBe(false));
  fireEvent.click(button(save));
  await expectToasts({ tone: 'success', message: success });
}

describe('Playback', () => {
  it('reports a failed save, and clears it once saving again succeeds', async () => {
    api.updatePlaybackSettings
      .mockResolvedValueOnce(failed('Could not save playback.'))
      .mockResolvedValueOnce({ ok: true, data: DEFAULT_PLAYBACK_SETTINGS });
    render(h(PlaybackForm, { initial: DEFAULT_PLAYBACK_SETTINGS }));

    await failThenSucceed('Save playback', 'Could not save playback.', 'Playback settings saved.');
  });
});

describe('Generation', () => {
  it('reports a failed Buffer save, and clears it once saving again succeeds', async () => {
    api.updateGenerationSettings
      .mockResolvedValueOnce(failed('Could not save the Buffer.'))
      .mockResolvedValueOnce({ ok: true, data: DEFAULT_GENERATION_SETTINGS });
    render(h(GenerationForm, { initial: DEFAULT_GENERATION_SETTINGS }));

    await failThenSucceed('Save Buffer', 'Could not save the Buffer.', 'Buffer settings saved.');
  });
});

describe('Language', () => {
  it('reports a failed save, and clears it once saving again succeeds', async () => {
    api.updateGenerationSettings
      .mockResolvedValueOnce(failed('Could not save the language.'))
      .mockResolvedValueOnce({ ok: true, data: DEFAULT_GENERATION_SETTINGS });
    render(h(LanguageForm, { initial: DEFAULT_GENERATION_SETTINGS }));

    await failThenSucceed(
      'Save language',
      'Could not save the language.',
      'Language setting saved.',
    );
  });
});

describe('Unit costs', () => {
  it('reports a failed save, clears it once saving again succeeds, and keeps the hint', async () => {
    const answers = [
      Response.json(
        { ok: false, error: { message: 'Could not save unit costs.' } },
        { status: 500 },
      ),
      Response.json({ ok: true, data: { unitCosts: { perTrackUsd: 0, perCoverUsd: 0 } } }),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answers.shift()!),
    );
    render(h(CostsPanel, { unitCosts: { perTrackUsd: 0, perCoverUsd: 0 } }));

    await failThenSucceed('Save unit costs', 'Could not save unit costs.', 'Unit costs saved.');
    expect(screen.getByText(UNIT_COSTS_HINT)).toBeTruthy();
  });
});

describe('Cover art', () => {
  function serveCoverArt(...answers: Response[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answers.shift()!),
    );
  }
  const saved = (enhancement?: { attempted: boolean; applied: boolean }) =>
    Response.json({ ok: true, settings: COVER_ART, enhancement });

  it('says the definition was optimized when the Writing AI rewrote it', async () => {
    serveCoverArt(saved({ attempted: true, applied: true }));
    render(h(CoverArtForm, { initial: COVER_ART, llmConfigured: true }));

    fireEvent.click(button('Save cover art'));

    await expectToasts({
      tone: 'success',
      message: 'Saved. Your definition was optimized by your Writing AI.',
    });
  });

  it('warns when it saved but enhancement was unavailable', async () => {
    serveCoverArt(saved({ attempted: true, applied: false }));
    render(h(CoverArtForm, { initial: COVER_ART, llmConfigured: true }));

    fireEvent.click(button('Save cover art'));

    await expectToasts({
      tone: 'warning',
      message: 'Saved. Enhancement was unavailable, so your definition was kept as written.',
    });
  });

  it('reports a failed save, and clears it once saving again succeeds', async () => {
    serveCoverArt(
      Response.json({ ok: false, error: 'Could not save cover art.' }, { status: 500 }),
      saved(),
    );
    render(h(CoverArtForm, { initial: COVER_ART, llmConfigured: false }));

    await failThenSucceed('Save cover art', 'Could not save cover art.', 'Saved.');
  });
});

describe('Personalization', () => {
  it('reports a setting that could not be saved, and clears it once one is', async () => {
    api.savePersonalization
      .mockResolvedValueOnce(failed('nope'))
      .mockResolvedValueOnce({ ok: true, data: { enabled: false } });
    render(h(PersonalizationSection, { initialEnabled: true }));
    const toggle = () => screen.getByRole('switch', { name: 'Personalize suggestions' });

    fireEvent.click(toggle());
    await expectToasts({ tone: 'error', message: 'The setting could not be saved.' });
    await waitFor(() => expect((toggle() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(toggle());

    await waitFor(() => expect(shownToasts()).toEqual([]));
  });

  it('says the learned taste was reset', async () => {
    api.resetLearnedTaste.mockResolvedValue({ ok: true, data: { reset: true } });
    render(h(PersonalizationSection, { initialEnabled: true }));

    fireEvent.click(button('Reset'));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset taste' }));

    await expectToasts({ tone: 'success', message: 'Learned taste reset.' });
  });

  it('reports a learned taste that could not be reset', async () => {
    api.resetLearnedTaste.mockResolvedValue(failed('nope'));
    render(h(PersonalizationSection, { initialEnabled: true }));

    fireEvent.click(button('Reset'));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset taste' }));

    await expectToasts({ tone: 'error', message: 'Your learned taste could not be reset.' });
  });
});
