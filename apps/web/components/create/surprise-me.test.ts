// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurpriseProposal } from '@liedmotif/shared';
import { AppChromeContext, type AppChromeContextValue } from '@/components/app-chrome-context';

const api = vi.hoisted(() => ({ proposeSurprise: vi.fn(), dismissSurprise: vi.fn() }));
vi.mock('@/lib/api-client', () => api);
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { SurpriseMe } = await import('./surprise-me');

const TIDE: SurpriseProposal = {
  id: '11111111-1111-4111-8111-111111111111',
  adventurous: false,
  title: 'Low Tide Radio',
  mood: 'hazy',
  genres: ['lofi', 'jazz'],
  energy: 'low',
  vocalMode: 'instrumental',
  voiceGender: null,
  language: null,
  skipProfile: false,
  edit: {
    prompt: 'Surprise me with an instrumental Lo-fi and Jazz session.',
    genres: ['lofi', 'jazz'],
    energy: 'low',
    vocal: 'instrumental',
    language: null,
    durationMinutes: 45,
  },
};
const EMBER: SurpriseProposal = {
  ...TIDE,
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Ember Choir',
  vocalMode: 'vocal',
  voiceGender: 'female',
  language: 'German',
};

beforeEach(() => {
  api.proposeSurprise.mockReset();
  api.dismissSurprise.mockReset();
  onProposalChange.mockReset();
  onStart.mockReset();
});
afterEach(cleanup);

const onProposalChange = vi.fn();
const onStart = vi.fn();
const CHROME: AppChromeContextValue = {
  listener: { name: 'Test', email: 'test@example.test', artistName: null, imageUrl: null },
  viewerRole: 'admin',
  ownVoiceOffered: false,
  themeMode: 'night',
  onToggleThemeMode: () => {},
  fetchChrome: () => new Promise(() => {}),
};
const mount = (props: { skipProfile?: boolean; initialProposal?: SurpriseProposal | null } = {}) =>
  render(
    createElement(
      AppChromeContext.Provider,
      { value: CHROME },
      createElement(SurpriseMe, {
        skipProfile: false,
        starting: false,
        onProposalChange,
        onStart,
        ...props,
      }),
    ),
  );

async function openModal() {
  fireEvent.click(screen.getByRole('button', { name: 'Surprise Me' }));
  return screen.findByRole('dialog');
}

const pressed = (dialog: HTMLElement, name: string) =>
  within(dialog).getByRole('button', { name }).getAttribute('aria-pressed');

describe('Surprise Me', () => {
  it('the dice opens the settings without spending anything', async () => {
    mount();
    const dialog = await openModal();
    expect(pressed(dialog, 'Familiar')).toBe('true');
    expect(pressed(dialog, 'Auto')).toBe('true');
    expect(pressed(dialog, 'Anything')).toBe('true');
    expect(api.proposeSurprise).not.toHaveBeenCalled();
  });

  it('finds a proposal with the chosen settings and previews it', async () => {
    api.proposeSurprise.mockResolvedValue({ ok: true, data: { proposal: EMBER } });
    mount({ skipProfile: true });
    const dialog = await openModal();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Adventurous' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'On the road' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Vocals' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Find a surprise' }));

    const preview = await screen.findByTestId('surprise-preview');
    expect(api.proposeSurprise).toHaveBeenCalledExactlyOnceWith(
      { adventurous: true, skipProfile: true, theme: 'travel', vocal: 'vocal', replaces: null },
      expect.any(AbortSignal),
    );
    expect(within(preview).getByText('Ember Choir')).toBeTruthy();
    expect(within(preview).getByText('Lo-fi, Jazz · hazy · Low energy')).toBeTruthy();
    expect(within(preview).getByText('Vocals · German · Female voice')).toBeTruthy();
    expect(onProposalChange).toHaveBeenCalledExactlyOnceWith(EMBER);
  });

  it('offers a language on Auto by default, for instrumental surprises too', async () => {
    mount();
    const dialog = await openModal();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Instrumental' }));
    const language = within(dialog).getByTestId('surprise-language');
    expect(language.textContent).toContain('Auto');
  });

  it('a song about me is always sung', async () => {
    mount();
    const dialog = await openModal();
    fireEvent.click(within(dialog).getByRole('button', { name: 'A song about me' }));
    const vocals = within(dialog).getByRole('button', { name: 'Vocals' });
    expect(vocals.getAttribute('aria-pressed')).toBe('true');
    expect(vocals.hasAttribute('disabled')).toBe(true);
  });

  it('opens on a proposal that was already pending, and starts it from the modal', async () => {
    mount({ initialProposal: TIDE });
    await openModal();
    const preview = screen.getByTestId('surprise-preview');
    expect(within(preview).getByText('Low Tide Radio')).toBeTruthy();
    expect(within(preview).getByText('Instrumental')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Start Session' }));
    expect(onStart).toHaveBeenCalledExactlyOnceWith(TIDE);
    expect(api.proposeSurprise).not.toHaveBeenCalled();
  });

  it('Cancel closes the modal and drops the request', async () => {
    let answer!: (value: unknown) => void;
    api.proposeSurprise.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    mount({ initialProposal: TIDE });
    const dialog = await openModal();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Try another' }));
    expect(within(dialog).getByRole('progressbar')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const signal = api.proposeSurprise.mock.calls[0]![1] as AbortSignal;
    expect(signal.aborted).toBe(true);
    // A late answer to a cancelled request changes nothing.
    answer({ ok: true, data: { proposal: EMBER } });
    await Promise.resolve();
    const reopened = await openModal();
    expect(within(reopened).getByText('Low Tide Radio')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onProposalChange).not.toHaveBeenCalled();
  });

  it('only Cancel ends the wait: Escape and clicking outside leave it running', async () => {
    api.proposeSurprise.mockReturnValue(new Promise(() => {}));
    mount();
    const dialog = await openModal();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Find a surprise' }));
    expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
    // Radix arms its outside-pointer listener on the next tick.
    await new Promise((resolve) => setTimeout(resolve));
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.getByRole('progressbar')).toBeTruthy();
    const signal = api.proposeSurprise.mock.calls[0]![1] as AbortSignal;
    expect(signal.aborted).toBe(false);
  });

  it('still closes on Escape when no proposal is in flight', async () => {
    mount();
    await openModal();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the previous proposal when Try another fails', async () => {
    api.proposeSurprise.mockResolvedValue({
      ok: false,
      error: { code: 'provider_error', message: 'The text LLM did not answer.', retryable: true },
    });
    mount({ initialProposal: TIDE });
    const dialog = await openModal();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Try another' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'The text LLM did not answer.',
    );
    expect(api.proposeSurprise).toHaveBeenCalledWith(
      expect.objectContaining({ replaces: TIDE.id }),
      expect.any(AbortSignal),
    );
    expect(screen.getByText('Low Tide Radio')).toBeTruthy();
  });

  it('explains missing headroom and points at existing music', async () => {
    api.proposeSurprise.mockResolvedValue({
      ok: false,
      error: {
        code: 'session_headroom_blocked',
        message: 'Today’s generation budget is used up.',
        retryable: false,
      },
    });
    mount();
    const dialog = await openModal();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Find a surprise' }));

    const blocked = await screen.findByTestId('creation-blocked-dialog');
    expect(within(blocked).getByText('Today’s generation budget is used up.')).toBeTruthy();
    expect(within(blocked).getByRole('button', { name: /Resume a Session/ })).toBeTruthy();
    expect(within(blocked).getByRole('button', { name: /Browse Library/ })).toBeTruthy();
  });

  it('dismisses the pending proposal and returns to the settings', async () => {
    api.dismissSurprise.mockResolvedValue({ ok: true, data: { dismissed: true } });
    mount({ initialProposal: TIDE });
    const dialog = await openModal();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => expect(screen.queryByTestId('surprise-preview')).toBeNull());
    expect(api.dismissSurprise).toHaveBeenCalledWith(TIDE.id);
    expect(onProposalChange).toHaveBeenCalledExactlyOnceWith(null);
    expect(within(dialog).getByRole('button', { name: 'Find a surprise' })).toBeTruthy();
  });
});
