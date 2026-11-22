// @vitest-environment jsdom

// Settings → Generation offers the Default Session duration as one choice of
// six, and Save stores the picked one with the ready-ahead target.

import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_GENERATION_SETTINGS } from '@liedmotif/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@/lib/toast';

const api = vi.hoisted(() => ({ updateGenerationSettings: vi.fn() }));
vi.mock('@/lib/http/api-client', () => api);
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const { GenerationForm } = await import('./generation-form');

beforeEach(() => {
  api.updateGenerationSettings.mockReset();
  router.refresh.mockReset();
  api.updateGenerationSettings.mockResolvedValue({ ok: true, data: DEFAULT_GENERATION_SETTINGS });
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

const choice = (name: string) => screen.getByRole('radio', { name }) as HTMLInputElement;

describe('New music per Session', () => {
  it('offers the six choices, with the shipped 30 min picked', () => {
    render(h(GenerationForm, { initial: DEFAULT_GENERATION_SETTINGS }));

    expect(
      screen.getAllByRole('radio').map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['5 min', '15 min', '30 min', '1 h', '2 h', 'No limit']);
    expect(choice('30 min').checked).toBe(true);
    expect(screen.getByText(/repeats for free/i)).toBeTruthy();
    expect(screen.getByText(/change any session in the player/i)).toBeTruthy();
    expect(screen.queryByText('Generate new tracks by default')).toBeNull();
  });

  it.each([
    ['1 h', 60],
    ['No limit', null],
  ])('saves %s with the ready-ahead target', async (name, minutes) => {
    render(h(GenerationForm, { initial: DEFAULT_GENERATION_SETTINGS }));

    fireEvent.click(choice(name));
    fireEvent.click(screen.getByRole('button', { name: 'Save New Music' }));

    await waitFor(() =>
      expect(api.updateGenerationSettings).toHaveBeenCalledWith({
        defaultSessionDurationMinutes: minutes,
        bufferAheadTracks: 3,
      }),
    );
  });

  it('refreshes the pages that show the default once it is saved', async () => {
    render(h(GenerationForm, { initial: DEFAULT_GENERATION_SETTINGS }));

    fireEvent.click(choice('No limit'));
    fireEvent.click(screen.getByRole('button', { name: 'Save New Music' }));

    // Home's Auto label is seeded from the saved default, and the router cache
    // would replay the old one for a while.
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
  });
});
