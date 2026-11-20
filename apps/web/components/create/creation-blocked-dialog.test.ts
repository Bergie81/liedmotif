// @vitest-environment jsdom

// Only the Admin can change cost limits, so the dialog's settings way out
// must follow the viewer's role: a Member blocked by their budget or the
// Members Pool lands on their own read-only budget page, never on Generation
// settings with nothing to adjust.

import { createElement as h } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppChromeContext, type AppChromeContextValue } from '@/components/app-chrome-context';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const { CreationBlockedDialog, CreationRefusalHost } = await import('./creation-blocked-dialog');
const { closeCreationRefusal, presentCreationFailure } = await import('./creation-refusal');

afterEach(() => {
  cleanup();
  push.mockReset();
  act(() => closeCreationRefusal());
});

function chromeFor(viewerRole: AppChromeContextValue['viewerRole']): AppChromeContextValue {
  return {
    listener: { name: 'Test', email: 'test@example.test', artistName: null, imageUrl: null },
    viewerRole,
    ownVoiceOffered: false,
    themeMode: 'night',
    onToggleThemeMode: () => {},
    fetchChrome: () => new Promise(() => {}),
  };
}

function renderDialog(viewerRole: AppChromeContextValue['viewerRole']): HTMLElement {
  render(
    h(
      AppChromeContext.Provider,
      { value: chromeFor(viewerRole) },
      h(CreationBlockedDialog, {
        open: true,
        onOpenChange: () => {},
        refusal: { kind: 'headroom', message: 'Budget used up.' },
      }),
    ),
  );
  return screen.getByTestId('creation-blocked-dialog');
}

describe('creation-blocked dialog title', () => {
  it('titles a headroom refusal by what is short', () => {
    const dialog = renderDialog('admin');
    expect(within(dialog).getByRole('heading').textContent).toBe('Not Enough Tracks Left to Start');
  });
});

// A pause is not a budget: waiting for a reset would not lift it, so it never
// shows under the headroom title.
describe('paused new music refusal', () => {
  function renderHost(viewerRole: AppChromeContextValue['viewerRole']) {
    render(h(AppChromeContext.Provider, { value: chromeFor(viewerRole) }, h(CreationRefusalHost)));
  }

  function presentPaused(message: string) {
    let inline: string | null = 'unset';
    act(() => {
      inline = presentCreationFailure({ code: 'new_music_paused', message }, 'Start failed');
    });
    expect(inline).toBeNull();
    return screen.getByTestId('creation-blocked-dialog');
  }

  it('opens under its own title, with the message and the free ways out', () => {
    renderHost('admin');
    const dialog = presentPaused('New Music is paused in Settings › Generation.');
    expect(within(dialog).getByRole('heading').textContent).toBe('New Music Is Paused');
    expect(within(dialog).getByText('New Music is paused in Settings › Generation.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /Resume a Session/ })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /Browse Library/ })).toBeTruthy();
  });

  it('takes the Admin to the switch, and offers a Member no budget page', () => {
    renderHost('admin');
    fireEvent.click(
      within(presentPaused('New Music is paused.')).getByRole('button', {
        name: /Open Generation Settings/,
      }),
    );
    expect(push).toHaveBeenCalledExactlyOnceWith('/settings/limits');
    cleanup();
    act(() => closeCreationRefusal());

    renderHost('member');
    const dialog = presentPaused('Thomas has paused new music.');
    expect(within(dialog).queryByRole('button', { name: /See Your Budget/ })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /Adjust Cost Limits/ })).toBeNull();
  });
});

// One presenter decides what a refused creation shows, wherever it was tapped.
describe('presentCreationFailure', () => {
  function renderHost() {
    render(h(AppChromeContext.Provider, { value: chromeFor('admin') }, h(CreationRefusalHost)));
  }

  it('opens the blocked dialog, with its ways out, for a headroom refusal', () => {
    renderHost();
    let inline: string | null = 'unset';
    act(() => {
      inline = presentCreationFailure(
        { code: 'session_headroom_blocked', message: 'A new session needs 5 Tracks.' },
        'More Like This didn’t start',
      );
    });
    expect(inline).toBeNull();
    const dialog = screen.getByTestId('creation-blocked-dialog');
    expect(within(dialog).getByText('A new session needs 5 Tracks.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /Resume a Session/ })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /Browse Library/ })).toBeTruthy();
  });

  it('hands any other failure back as its line of text, with no dialog', () => {
    renderHost();
    let inline: string | null = null;
    act(() => {
      inline = presentCreationFailure(
        { code: 'not_found', message: 'Track not found.' },
        'More Like This didn’t start',
      );
    });
    expect(inline).toBe('More Like This didn’t start: Track not found.');
    expect(screen.queryByTestId('creation-blocked-dialog')).toBeNull();
  });
});

describe('creation-blocked dialog settings way out', () => {
  it('sends the Admin to cost limits', () => {
    const dialog = renderDialog('admin');
    expect(within(dialog).queryByRole('button', { name: /See Your Budget/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: /Adjust Cost Limits/ }));
    expect(push).toHaveBeenCalledExactlyOnceWith('/settings/limits');
  });

  it('sends a Member to their own budget', () => {
    const dialog = renderDialog('member');
    expect(within(dialog).queryByRole('button', { name: /Adjust Cost Limits/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: /See Your Budget/ }));
    expect(push).toHaveBeenCalledExactlyOnceWith('/settings/my-budget');
  });
});
