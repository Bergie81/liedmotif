// @vitest-environment jsdom

// The one More Like This sheet every surface opens: it names its seed, offers a
// context field and a language picker only when a text LLM can read them,
// sends no context for a blank field and no language on Auto Detect, and keeps
// the typed words when the start is refused.

import { createElement as h } from 'react';
import { MAX_USER_PROMPT_LENGTH } from '@liedmotif/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { AppChromeContext, type AppChromeContextValue } from '@/components/app-chrome-context';
import {
  MoreLikeThisSheet,
  type MoreLikeThisAsk,
  type MoreLikeThisSeed,
} from './more-like-this-sheet';

afterEach(cleanup);
beforeAll(() => {
  // jsdom lacks the pointer and scroll APIs Radix Select calls.
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.scrollIntoView = () => {};
});

const TRACK_SEED: MoreLikeThisSeed = { kind: 'track', title: 'Nachtfahrt' };

function renderSheet({
  llmConfigured = true,
  seed = TRACK_SEED,
  onStart = vi.fn(async () => true),
}: {
  llmConfigured?: boolean;
  seed?: MoreLikeThisSeed;
  onStart?: (ask: MoreLikeThisAsk) => Promise<boolean>;
} = {}) {
  const onOpenChange = vi.fn();
  const sheet = (open: boolean) =>
    h(
      AppChromeContext.Provider,
      { value: { llmConfigured } as AppChromeContextValue },
      h(MoreLikeThisSheet, { seed, open, onOpenChange, onStart }),
    );
  const { rerender } = render(sheet(true));
  return { onStart, onOpenChange, setOpen: (open: boolean) => rerender(sheet(open)) };
}

async function start() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start New Session' }));
  });
}

function typeContext(text: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
}

function languagePicker() {
  return screen.getByRole('combobox', { name: 'Language' });
}

async function pickLanguage(label: string) {
  fireEvent.keyDown(languagePicker(), { key: 'Enter' });
  const option = await screen.findByRole('option', { name: label });
  fireEvent.keyDown(option, { key: 'Enter' });
}

it('names a Track seed by its title', () => {
  renderSheet();
  expect(screen.getByText('Nachtfahrt')).toBeTruthy();
});

it('names a Playlist seed by the Tracks it seeds from', () => {
  renderSheet({ seed: { kind: 'playlist', name: 'Running', trackCount: 10 } });
  expect(screen.getByText('10 tracks from Running')).toBeTruthy();
});

it('offers no context field and no language picker without a text LLM', async () => {
  const { onStart } = renderSheet({ llmConfigured: false });
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('combobox')).toBeNull();
  await start();
  expect(onStart).toHaveBeenCalledWith({});
});

it('offers a context field that says it never changes the style', () => {
  renderSheet();
  expect(screen.getByRole('textbox')).toBeTruthy();
  expect(screen.getByText(/never the style/)).toBeTruthy();
});

it('sends no context for a whitespace-only field', async () => {
  const { onStart } = renderSheet();
  typeContext('   \n ');
  await start();
  expect(onStart).toHaveBeenCalledWith({});
});

it('sends the typed context trimmed', async () => {
  const { onStart } = renderSheet();
  typeContext('  for cooking  ');
  await start();
  expect(onStart).toHaveBeenCalledWith({ context: 'for cooking' });
});

it('caps the context at the user-prompt limit', async () => {
  const { onStart } = renderSheet();
  typeContext('a'.repeat(MAX_USER_PROMPT_LENGTH + 50));
  await start();
  expect(onStart).toHaveBeenCalledWith({ context: 'a'.repeat(MAX_USER_PROMPT_LENGTH) });
});

it('closes once the new Session started', async () => {
  const { onOpenChange } = renderSheet();
  await start();
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it('stays open with the typed words when the start is refused', async () => {
  const { onOpenChange } = renderSheet({ onStart: async () => false });
  typeContext('about autumn in Berlin');
  await start();
  expect(onOpenChange).not.toHaveBeenCalled();
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('about autumn in Berlin');
});

it('shows the busy loader and ignores a repeat tap while the first start is in flight', async () => {
  let settle: (started: boolean) => void = () => {};
  const onStart = vi.fn(() => new Promise<boolean>((resolve) => (settle = resolve)));
  renderSheet({ onStart });
  await start();
  const busyButton = screen.getByRole('button', { name: 'Starting Session…' });
  expect(busyButton).toHaveProperty('disabled', true);
  expect(busyButton.getAttribute('aria-busy')).toBe('true');
  expect(busyButton.querySelector('svg')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Starting Session…' }));
  expect(onStart).toHaveBeenCalledTimes(1);
  await act(async () => settle(false));
  expect(screen.getByRole('button', { name: 'Start New Session' })).toBeTruthy();
});

it('cannot be dismissed while a start is in flight, which no dismissal would stop', async () => {
  let settle: (started: boolean) => void = () => {};
  renderSheet({ onStart: () => new Promise<boolean>((resolve) => (settle = resolve)) });
  await start();
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Close More Like This' })).toHaveProperty(
    'disabled',
    true,
  );
  await act(async () => settle(false));
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', false);
});

it('offers a language picker on Auto Detect that says the words and vocals follow it', () => {
  renderSheet();
  expect(languagePicker().textContent).toContain('Auto Detect');
  expect(
    screen.getByText('Auto Detect uses the language you write in. Vocals are sung in it too.'),
  ).toBeTruthy();
});

it('sends a picked language with the context', async () => {
  const { onStart } = renderSheet();
  typeContext('for cooking');
  await pickLanguage('German');
  await start();
  expect(onStart).toHaveBeenCalledWith({ context: 'for cooking', language: 'German' });
});

it('sends a picked language with an empty field', async () => {
  const { onStart } = renderSheet();
  await pickLanguage('Spanish');
  await start();
  expect(onStart).toHaveBeenCalledWith({ language: 'Spanish' });
});

it('sends no language when Auto Detect is picked back', async () => {
  const { onStart } = renderSheet();
  await pickLanguage('German');
  await pickLanguage('Auto Detect');
  await start();
  expect(onStart).toHaveBeenCalledWith({});
});

it('opens on Auto Detect again after a pick', async () => {
  const { setOpen } = renderSheet();
  await pickLanguage('German');
  expect(languagePicker().textContent).toContain('German');
  setOpen(false);
  setOpen(true);
  expect(languagePicker().textContent).toContain('Auto Detect');
});
