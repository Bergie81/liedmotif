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
import { shownToasts, toast } from '@/lib/toast';

const saveUsageLimits = vi.hoisted(() => vi.fn());
vi.mock('@/lib/settings/settings-client', () => ({ saveUsageLimits }));

const { LimitsForm } = await import('./limits-form');

afterEach(() => {
  cleanup();
  saveUsageLimits.mockReset();
  toast.dismiss();
});

/** Waits until the one toast on screen is this one. */
async function expectToast(tone: string, message: string) {
  await waitFor(() => expect(shownToasts()).toEqual([expect.objectContaining({ tone, message })]));
}

function renderForm(initial = defaultUsageLimits()) {
  const fetchChrome = vi.fn(() => new Promise<never>(() => {}));
  const chrome: AppChromeContextValue = {
    listener: { name: 'Admin', email: 'admin@example.test', artistName: null, imageUrl: null },
    viewerRole: 'admin',
    ownVoiceOffered: false,
    llmConfigured: false,
    themeMode: 'night',
    onToggleThemeMode: () => {},
    fetchChrome,
  };
  render(
    h(
      AppChromeContext.Provider,
      { value: chrome },
      h(LimitsForm, {
        initial,
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
  it('offers a Save button under Cost Controls as well as under Cover Art Budget', () => {
    renderForm();
    expect(
      within(section('Cost Controls')).getByRole('button', { name: 'Save Limits' }),
    ).toBeTruthy();
    expect(
      within(section('Cover Art Budget')).getByRole('button', { name: 'Save Limits' }),
    ).toBeTruthy();
  });

  it('refreshes the shell headroom after a successful save', async () => {
    saveUsageLimits.mockResolvedValue({ ok: true, data: defaultUsageLimits() });
    const { fetchChrome } = renderForm();

    fireEvent.click(within(section('Cost Controls')).getByRole('button', { name: 'Save Limits' }));

    await waitFor(() => expect(fetchChrome).toHaveBeenCalledTimes(1));
    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'success', message: 'Generation and cost limits saved.' }),
    ]);
  });

  it('leaves the shell alone when the save fails', async () => {
    saveUsageLimits.mockResolvedValue({ ok: false, error: 'Could not save limits.' });
    const { fetchChrome } = renderForm();

    fireEvent.click(
      within(section('Cover Art Budget')).getByRole('button', { name: 'Save Limits' }),
    );

    await expectToast('error', 'Could not save limits.');
    expect(fetchChrome).not.toHaveBeenCalled();
  });

  it('clears a failed save once saving again succeeds', async () => {
    saveUsageLimits.mockResolvedValueOnce({ ok: false, error: 'Could not save limits.' });
    saveUsageLimits.mockResolvedValueOnce({ ok: true, data: defaultUsageLimits() });
    renderForm();
    const save = within(section('Cost Controls')).getByRole('button', { name: 'Save Limits' });

    fireEvent.click(save);
    await waitFor(() => expect(shownToasts()).toHaveLength(1));
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);

    await expectToast('success', 'Generation and cost limits saved.');
  });

  it('reports out-of-range values as a toast and keeps the note under the field', async () => {
    renderForm({ ...defaultUsageLimits(), maxQueuedTracks: 100_000 });

    fireEvent.click(within(section('Cost Controls')).getByRole('button', { name: 'Save Limits' }));

    await expectToast('error', 'Check the highlighted limit values.');
    expect(saveUsageLimits).not.toHaveBeenCalled();
    const row = screen.getByText('Max queued tracks').parentElement!;
    expect(row.querySelector('.text-warn')?.textContent).toBeTruthy();
  });
});
