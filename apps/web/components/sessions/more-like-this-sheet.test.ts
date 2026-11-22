// @vitest-environment jsdom

// The one More Like This sheet every surface opens: it names its seed, offers a
// context field only when a text LLM can read it, sends no context for a blank
// field, and keeps the typed words when the start is refused.

import { createElement as h } from 'react';
import { MAX_USER_PROMPT_LENGTH } from '@liedmotif/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppChromeContext, type AppChromeContextValue } from '@/components/app-chrome-context';
import { MoreLikeThisSheet, type MoreLikeThisSeed } from './more-like-this-sheet';

afterEach(cleanup);

const TRACK_SEED: MoreLikeThisSeed = { kind: 'track', title: 'Nachtfahrt' };

function renderSheet({
  llmConfigured = true,
  seed = TRACK_SEED,
  onStart = vi.fn(async () => true),
}: {
  llmConfigured?: boolean;
  seed?: MoreLikeThisSeed;
  onStart?: (context: string | undefined) => Promise<boolean>;
} = {}) {
  const onOpenChange = vi.fn();
  render(
    h(
      AppChromeContext.Provider,
      { value: { llmConfigured } as AppChromeContextValue },
      h(MoreLikeThisSheet, { seed, open: true, onOpenChange, onStart }),
    ),
  );
  return { onStart, onOpenChange };
}

async function start() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start New Session' }));
  });
}

function typeContext(text: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
}

it('names a Track seed by its title', () => {
  renderSheet();
  expect(screen.getByText('Nachtfahrt')).toBeTruthy();
});

it('names a Playlist seed by the Tracks it seeds from', () => {
  renderSheet({ seed: { kind: 'playlist', name: 'Running', trackCount: 10 } });
  expect(screen.getByText('10 tracks from Running')).toBeTruthy();
});

it('offers no context field without a text LLM and starts with no context', async () => {
  const { onStart } = renderSheet({ llmConfigured: false });
  expect(screen.queryByRole('textbox')).toBeNull();
  await start();
  expect(onStart).toHaveBeenCalledWith(undefined);
});

it('offers a context field that says it never changes the music', () => {
  renderSheet();
  expect(screen.getByRole('textbox')).toBeTruthy();
  expect(screen.getByText(/never the music/)).toBeTruthy();
});

it('sends no context for a whitespace-only field', async () => {
  const { onStart } = renderSheet();
  typeContext('   \n ');
  await start();
  expect(onStart).toHaveBeenCalledWith(undefined);
});

it('sends the typed context trimmed', async () => {
  const { onStart } = renderSheet();
  typeContext('  for cooking  ');
  await start();
  expect(onStart).toHaveBeenCalledWith('for cooking');
});

it('caps the context at the user-prompt limit', async () => {
  const { onStart } = renderSheet();
  typeContext('a'.repeat(MAX_USER_PROMPT_LENGTH + 50));
  await start();
  expect(onStart).toHaveBeenCalledWith('a'.repeat(MAX_USER_PROMPT_LENGTH));
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

it('ignores a repeat tap while the first start is in flight', async () => {
  let settle: (started: boolean) => void = () => {};
  const onStart = vi.fn(() => new Promise<boolean>((resolve) => (settle = resolve)));
  renderSheet({ onStart });
  await start();
  expect(screen.getByRole('button', { name: 'Starting Session…' })).toHaveProperty(
    'disabled',
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Starting Session…' }));
  expect(onStart).toHaveBeenCalledTimes(1);
  await act(async () => settle(false));
  expect(screen.getByRole('button', { name: 'Start New Session' })).toBeTruthy();
});
