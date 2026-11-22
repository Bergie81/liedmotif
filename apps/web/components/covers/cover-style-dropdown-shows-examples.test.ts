// @vitest-environment jsdom

// The cover style dropdown (create card, Session Cover and Playlist Cover
// sheets): every option carries the style's example tile and one-line
// explanation beside its name. Both are shown from the desktop breakpoint up
// by CSS, which jsdom does not evaluate, so these tests read the markup.

import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COVER_STYLE_CHOICES,
  COVER_STYLE_PRESETS,
  PLAYLIST_COVER_STYLE_CHOICES,
} from '@liedmotif/shared';
import type { CoverStyleChoice } from '@liedmotif/shared';
import {
  COVER_STYLE_EXPLANATIONS,
  COVER_STYLE_LABELS,
  coverStyleExampleSrc,
} from '@/lib/covers/cover-styles';
import { CoverStyleSelect } from './cover-style-select';

afterEach(cleanup);

// The open Select scrolls its selected option into view, which jsdom lacks.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

function openDropdown(choices: readonly CoverStyleChoice[], value: CoverStyleChoice) {
  render(
    h(CoverStyleSelect, { choices, value, onChange: () => {}, disabled: false, testId: 'style' }),
  );
  fireEvent.keyDown(screen.getByTestId('style'), { key: 'Enter' });
}

/** The example files an option shows, as the paths the picker resolves. */
function exampleSources(option: HTMLElement): string[] {
  return [...option.querySelectorAll('img')].map((image) => {
    const src = image.getAttribute('src') ?? '';
    // next/image wraps the file in its optimizer URL under vitest.
    return new URL(src, 'http://localhost').searchParams.get('url') ?? src;
  });
}

describe('the cover style dropdown', () => {
  it('names every option by its style alone and adds the explanation', async () => {
    openDropdown(COVER_STYLE_CHOICES, 'auto');
    await screen.findAllByRole('option');
    for (const choice of COVER_STYLE_CHOICES) {
      const option = screen.getByRole('option', { name: COVER_STYLE_LABELS[choice] });
      expect(option.textContent).toContain(COVER_STYLE_EXPLANATIONS[choice]);
    }
  });

  it('shows the example of each preset style in its option', async () => {
    openDropdown(COVER_STYLE_CHOICES, 'auto');
    await screen.findAllByRole('option');
    for (const preset of COVER_STYLE_PRESETS) {
      const option = screen.getByRole('option', { name: COVER_STYLE_LABELS[preset] });
      expect(exampleSources(option)).toEqual([coverStyleExampleSrc(preset)]);
    }
  });

  it('shows all six examples for Auto and Random and none for Custom', async () => {
    openDropdown(COVER_STYLE_CHOICES, 'auto');
    await screen.findAllByRole('option');
    const all = COVER_STYLE_PRESETS.map(coverStyleExampleSrc);
    expect(exampleSources(screen.getByRole('option', { name: 'Auto' }))).toEqual(all);
    expect(exampleSources(screen.getByRole('option', { name: 'Random' }))).toEqual(all);
    expect(exampleSources(screen.getByRole('option', { name: 'Custom' }))).toEqual([]);
  });

  it('keeps the closed dropdown to the style name', () => {
    render(
      h(CoverStyleSelect, {
        choices: COVER_STYLE_CHOICES,
        value: 'manga',
        onChange: () => {},
        disabled: false,
        testId: 'style',
      }),
    );
    expect(screen.getByTestId('style').textContent).toBe(COVER_STYLE_LABELS.manga);
  });

  it('offers exactly the choices it is given, in their order', async () => {
    openDropdown(PLAYLIST_COVER_STYLE_CHOICES, 'random');
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.getAttribute('aria-labelledby'))).toHaveLength(
      PLAYLIST_COVER_STYLE_CHOICES.length,
    );
    expect(screen.queryByRole('option', { name: 'Auto' })).toBeNull();
  });
});
