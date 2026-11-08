// @vitest-environment jsdom

// The sidebar headroom chip is shell state read once per navigation, so a
// saved limit change must push a fresh chrome read or the chip keeps showing
// the old ceiling until a reload. Both limit sections carry their own Save
// button: the form spans two cards and a single button under the second reads
// as belonging to Cover art only.

import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { defaultUsageLimits } from '@liedmotif/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppChromeContext, type AppChromeContextValue } from '@/components/app-chrome-context';

const saveUsageLimits = vi.hoisted(() => vi.fn());
vi.mock('@/lib/settings-client', () => ({ saveUsageLimits }));

const { LimitsForm } = await import('./limits-form');

afterEach(() => {
  cleanup();
  saveUsageLimits.mockReset();
});

function renderForm() {
  const fetchChrome = vi.fn(() => new Promise<never>(() => {}));
  const chrome: AppChromeContextValue = {
    listener: { name: 'Admin', email: 'admin@example.test', artistName: null, imageUrl: null },
    viewerRole: 'admin',
    ownVoiceOffered: false,
    themeMode: 'night',
    onToggleThemeMode: () => {},
    fetchChrome,
  };
  render(
    h(
      AppChromeContext.Provider,
      { value: chrome },
      h(LimitsForm, {
        initial: defaultUsageLimits(),
        tracksPerRequest: 2,
        unitCosts: { perTrackUsd: 0.07, perCoverUsd: 0.04 },
      }),
    ),
  );
  return { fetchChrome };
}

function section(title: string): HTMLElement {
  return screen.getByRole('heading', { name: title }).closest('section')!;
}

describe('saving generation limits', () => {
  it('offers a Save button under Cost controls as well as under Cover art budget', () => {
    renderForm();
    expect(
      within(section('Cost controls')).getByRole('button', { name: 'Save limits' }),
    ).toBeTruthy();
    expect(
      within(section('Cover art budget')).getByRole('button', { name: 'Save limits' }),
    ).toBeTruthy();
  });

  it('refreshes the shell headroom after a successful save', async () => {
    saveUsageLimits.mockResolvedValue({ ok: true, data: defaultUsageLimits() });
    const { fetchChrome } = renderForm();

    fireEvent.click(within(section('Cost controls')).getByRole('button', { name: 'Save limits' }));

    await waitFor(() => expect(fetchChrome).toHaveBeenCalledTimes(1));
    expect(
      within(section('Cost controls')).getByText('Generation and cost limits saved.'),
    ).toBeTruthy();
  });

  it('leaves the shell alone when the save fails', async () => {
    saveUsageLimits.mockResolvedValue({ ok: false, error: 'Could not save limits.' });
    const { fetchChrome } = renderForm();

    fireEvent.click(
      within(section('Cover art budget')).getByRole('button', { name: 'Save limits' }),
    );

    await screen.findByText('Could not save limits.');
    expect(fetchChrome).not.toHaveBeenCalled();
  });
});
