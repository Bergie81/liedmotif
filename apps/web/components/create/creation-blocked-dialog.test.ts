// @vitest-environment jsdom

// Only the Admin can change cost limits, so the dialog's settings way out
// must follow the viewer's role: a Member blocked by their budget or the
// Members Pool lands on their own read-only budget page, never on Generation
// settings with nothing to adjust.

import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppChromeContext, type AppChromeContextValue } from '@/components/app-chrome-context';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const { CreationBlockedDialog } = await import('./creation-blocked-dialog');

afterEach(() => {
  cleanup();
  push.mockReset();
});

function renderDialog(viewerRole: AppChromeContextValue['viewerRole']): HTMLElement {
  const chrome: AppChromeContextValue = {
    listener: { name: 'Test', email: 'test@example.test', artistName: null, imageUrl: null },
    viewerRole,
    ownVoiceOffered: false,
    themeMode: 'night',
    onToggleThemeMode: () => {},
    fetchChrome: () => new Promise(() => {}),
  };
  render(
    h(
      AppChromeContext.Provider,
      { value: chrome },
      h(CreationBlockedDialog, { open: true, onOpenChange: () => {}, message: 'Budget used up.' }),
    ),
  );
  return screen.getByTestId('creation-blocked-dialog');
}

describe('creation-blocked dialog settings way out', () => {
  it('sends the Admin to cost limits', () => {
    const dialog = renderDialog('admin');
    expect(within(dialog).queryByRole('button', { name: /See your budget/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: /Adjust cost limits/ }));
    expect(push).toHaveBeenCalledExactlyOnceWith('/settings/limits');
  });

  it('sends a Member to their own budget', () => {
    const dialog = renderDialog('member');
    expect(within(dialog).queryByRole('button', { name: /Adjust cost limits/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: /See your budget/ }));
    expect(push).toHaveBeenCalledExactlyOnceWith('/settings/my-budget');
  });
});
