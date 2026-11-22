// @vitest-environment jsdom

// Settings › Cover Art: the default cover style is one radio row per choice,
// each with its name and a one-line explanation. The Custom style definition
// under the Custom row is always editable, because Custom is also picked per
// Session, on cover regeneration and by Random, not only as the default.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CoverArtSettings } from '@liedmotif/db';
import { COVER_STYLE_PRESETS } from '@liedmotif/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coverStyleExampleSrc } from '@/lib/covers/cover-styles';
import { shownToasts, toast } from '@/lib/toast';
import { CoverArtForm } from './cover-art-form';

const SAVED: CoverArtSettings = {
  defaultStyle: 'photographic',
  customStyleDefinition: '',
  useStandardCoverArt: false,
  promptEnhancementEnabled: false,
};

afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.unstubAllGlobals();
});

/**
 * Answers each save with the posted settings overlaid by `stored`, plus any
 * `extra` response fields, and records the bodies sent.
 */
function stubSave(stored: Partial<CoverArtSettings> = {}, extra: Record<string, unknown> = {}) {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return Response.json({ ok: true, settings: { ...body, ...stored }, ...extra });
    }),
  );
  return bodies;
}

function renderForm(initial: Partial<CoverArtSettings> = {}, llmConfigured = true) {
  render(h(CoverArtForm, { initial: { ...SAVED, ...initial }, llmConfigured }));
}

const styleGroup = () => screen.getByRole('group', { name: 'Default cover style' });
const styleRadio = (name: string) => within(styleGroup()).getByRole('radio', { name });
const definitionField = () => screen.getByTestId('cover-style-definition') as HTMLTextAreaElement;

/** The file each image in a style's row requests, unwrapped from the Next image URL. */
function rowImageSources(name: string): string[] {
  const row = styleRadio(name).closest('label')!;
  return [...row.querySelectorAll('img')].map((img) => {
    const src = img.getAttribute('src') ?? '';
    if (!src.startsWith('/_next/image')) return src;
    return new URLSearchParams(src.slice(src.indexOf('?') + 1)).get('url') ?? '';
  });
}

const PRESET_EXAMPLES = [
  '/cover-styles/record_sleeve.webp',
  '/cover-styles/poster_art.webp',
  '/cover-styles/photographic.webp',
  '/cover-styles/manga.webp',
  '/cover-styles/drawing.webp',
  '/cover-styles/minimal.webp',
];

async function saveAndReadBody(bodies: Array<Record<string, unknown>>) {
  fireEvent.click(screen.getByRole('button', { name: 'Save Cover Art' }));
  await waitFor(() => expect(bodies).toHaveLength(1));
  return bodies[0]!;
}

describe('Default cover style picker', () => {
  it('shows one radio per cover style, Auto first and Custom last, with the saved default checked', () => {
    renderForm();

    const radios = within(styleGroup()).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((radio) => radio.value)).toEqual([
      'auto',
      'random',
      'record_sleeve',
      'poster_art',
      'photographic',
      'manga',
      'drawing',
      'minimal',
      'custom',
    ]);
    expect(radios.filter((radio) => radio.checked).map((radio) => radio.value)).toEqual([
      'photographic',
    ]);
  });

  it.each([
    ['Auto', 'Picks the style that fits each session.'],
    ['Random', 'A different style for every session.'],
    ['Record Sleeve', 'An album cover from one decade, 1960s to 2000s.'],
    ['Artistic', 'Bold graphic artwork around one strong visual idea.'],
    ['Photographic', 'A believable photo of one real moment.'],
    ['Manga', 'Black-and-white manga ink with expressive characters.'],
    ['Drawing', 'A hand-made pencil or ink drawing on paper.'],
    ['Minimal', 'One motif, lots of empty space, two or three flat colors.'],
    ['Custom', 'Your own style, written below.'],
  ])('names %s with its explanation, and the whole row selects it', (name, explanation) => {
    renderForm({ defaultStyle: name === 'Auto' ? 'minimal' : 'auto' });

    const radio = within(styleGroup()).getByRole('radio', {
      name,
      description: explanation,
    }) as HTMLInputElement;

    fireEvent.click(within(styleGroup()).getByText(explanation));
    expect(radio.checked).toBe(true);
  });
});

describe('Example tiles', () => {
  it.each([
    ['Record Sleeve', '/cover-styles/record_sleeve.webp'],
    ['Artistic', '/cover-styles/poster_art.webp'],
    ['Photographic', '/cover-styles/photographic.webp'],
    ['Manga', '/cover-styles/manga.webp'],
    ['Drawing', '/cover-styles/drawing.webp'],
    ['Minimal', '/cover-styles/minimal.webp'],
  ])('shows the %s example cover as decoration', (name, src) => {
    renderForm();

    expect(rowImageSources(name)).toEqual([src]);
    const image = styleRadio(name).closest('label')!.querySelector('img')!;
    expect(image.getAttribute('alt')).toBe('');
  });

  it('shows all six examples for Auto and Random, and no image for Custom', () => {
    renderForm();

    expect(rowImageSources('Auto')).toEqual(PRESET_EXAMPLES);
    expect(rowImageSources('Random')).toEqual(PRESET_EXAMPLES);
    expect(rowImageSources('Custom')).toEqual([]);
    for (const img of styleGroup().querySelectorAll('img')) {
      expect(img.getAttribute('alt')).toBe('');
    }
  });

  it('ships an example image file for every preset style', () => {
    const publicDir = join(import.meta.dirname, '..', '..', 'public');
    const missing = COVER_STYLE_PRESETS.filter(
      (preset) => !existsSync(join(publicDir, coverStyleExampleSrc(preset))),
    );
    expect(missing).toEqual([]);
  });
});

describe('Custom style definition', () => {
  it('stays editable under another default, and typing in it leaves that default selected', async () => {
    const bodies = stubSave();
    renderForm({ defaultStyle: 'photographic' });

    expect(definitionField().disabled).toBe(false);
    fireEvent.focus(definitionField());
    fireEvent.change(definitionField(), { target: { value: 'woodcut, rough grain' } });

    expect((styleRadio('Photographic') as HTMLInputElement).checked).toBe(true);
    expect(await saveAndReadBody(bodies)).toMatchObject({
      defaultStyle: 'photographic',
      customStyleDefinition: 'woodcut, rough grain',
    });
  });

  it('keeps the style list and the definition editable while Tailored Cover Art is off', async () => {
    const bodies = stubSave();
    renderForm({ useStandardCoverArt: true, defaultStyle: 'auto' });

    fireEvent.click(styleRadio('Manga'));
    fireEvent.change(definitionField(), { target: { value: 'ink wash' } });

    expect((styleRadio('Manga') as HTMLInputElement).checked).toBe(true);
    expect(await saveAndReadBody(bodies)).toMatchObject({
      defaultStyle: 'manga',
      customStyleDefinition: 'ink wash',
      useStandardCoverArt: true,
    });
  });

  it('always shows the writing tip and the character counter', () => {
    renderForm({ defaultStyle: 'auto', customStyleDefinition: 'linocut' });

    expect(screen.getByText(/not fixed colors or objects/)).toBeTruthy();
    expect(screen.getByText('7/240')).toBeTruthy();
    expect(screen.queryByText('Select Custom to edit your definition.')).toBeNull();
  });

  it('is named by its heading alone, with the tip and the hint as its description', () => {
    renderForm({ defaultStyle: 'custom', customStyleDefinition: '' });

    const field = screen.getByRole('textbox', {
      name: 'Custom style definition',
      description: /not fixed colors or objects.*Without a definition, Custom works like Auto\.$/,
    });
    expect(field).toBe(definitionField());
  });

  it('says Custom works like Auto only while Custom is selected and the definition is empty', () => {
    const hint = () => screen.queryByText('Without a definition, Custom works like Auto.');
    renderForm({ defaultStyle: 'auto', customStyleDefinition: '' });
    expect(hint()).toBeNull();

    fireEvent.click(styleRadio('Custom'));
    expect(hint()).toBeTruthy();

    fireEvent.change(definitionField(), { target: { value: '   ' } });
    expect(hint()).toBeTruthy();

    fireEvent.change(definitionField(), { target: { value: 'pastel chalk' } });
    expect(hint()).toBeNull();

    fireEvent.change(definitionField(), { target: { value: '' } });
    fireEvent.click(styleRadio('Minimal'));
    expect(hint()).toBeNull();
    expect(shownToasts()).toEqual([]);
  });
});

describe('Save Cover Art', () => {
  it('posts the picked style and reports the save as a toast', async () => {
    const bodies = stubSave();
    renderForm({ defaultStyle: 'auto' });

    fireEvent.click(styleRadio('Record Sleeve'));

    expect(await saveAndReadBody(bodies)).toMatchObject({ defaultStyle: 'record_sleeve' });
    await waitFor(() =>
      expect(shownToasts()).toMatchObject([{ tone: 'success', message: 'Saved.' }]),
    );
  });

  it('shows the stored definition after a save the text AI enhanced', async () => {
    stubSave(
      { customStyleDefinition: 'Hand-cut woodblock print, rough grain.' },
      { enhancement: { attempted: true, applied: true } },
    );
    renderForm({ defaultStyle: 'minimal', promptEnhancementEnabled: true });

    fireEvent.change(definitionField(), { target: { value: 'woodcut' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Cover Art' }));

    await waitFor(() =>
      expect(definitionField().value).toBe('Hand-cut woodblock print, rough grain.'),
    );
    expect((styleRadio('Minimal') as HTMLInputElement).checked).toBe(true);
  });

  it('locks Enhance prompts only without a text AI', () => {
    const enhance = () =>
      screen.getByRole('switch', { name: 'Enhance prompts with the text AI' }) as HTMLButtonElement;
    renderForm({ useStandardCoverArt: true }, true);
    expect(enhance().disabled).toBe(false);
    cleanup();

    renderForm({}, false);
    expect(enhance().disabled).toBe(true);
    expect(definitionField().disabled).toBe(false);
    expect((styleRadio('Custom') as HTMLInputElement).disabled).toBe(false);
  });
});
