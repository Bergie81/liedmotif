// @vitest-environment jsdom

// On a phone the Player keeps its seek bar and transport where the Assistant's
// floating launcher sits, so the shell shows none there and the Player's phone
// header carries the launcher instead.

import { createElement as h, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppChromeContext, type AppChromeContextValue } from '@/components/app-chrome-context';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ShellAssistant } from '@/tests/helpers/shell-assistant';
import { PlayerMobileHeader } from './player-mobile-header';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

/** jsdom has no media queries: say which side of the `desk` breakpoint the window is on. */
function onScreen(desk: boolean) {
  vi.stubGlobal(
    'matchMedia',
    () => ({ matches: desk, addEventListener: () => {}, removeEventListener: () => {} }) as never,
  );
}

afterEach(cleanup);

/** The app shell on the Player: the page carries the phone's launcher. */
function Shell({ children }: { children?: ReactNode }) {
  return h(
    TooltipProvider,
    null,
    h(
      ShellAssistant,
      { links: { appPaths: [], docsPages: [] }, pageCarriesPhoneLauncher: true },
      children,
    ),
  );
}

const chrome = {
  listener: { name: 'Thea', email: 'thea@example.com', artistName: null, imageUrl: null },
  themeMode: 'night',
  onToggleThemeMode: () => {},
} as unknown as AppChromeContextValue;

const phoneHeader = h(
  AppChromeContext.Provider,
  { value: chrome },
  h(PlayerMobileHeader, { title: 'Now Playing your Session', action: null }),
);

it('opens the Assistant from the phone header of the Player', () => {
  onScreen(false);
  render(h(Shell, null, phoneHeader));
  expect(screen.queryByRole('dialog')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Ask Roadie' }));

  expect(screen.getByRole('dialog', { name: 'Roadie' })).toBeTruthy();
});

it('hands focus back to the phone header button when the panel closes', async () => {
  onScreen(false);
  render(h(Shell, null, phoneHeader));
  const launcher = screen.getByRole('button', { name: 'Ask Roadie' });
  fireEvent.click(launcher);

  fireEvent.keyDown(screen.getByRole('dialog', { name: 'Roadie' }), { key: 'Escape' });

  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(launcher));
});

it('shows no Assistant button to a viewer without the Assistant', () => {
  onScreen(false);
  render(h(TooltipProvider, null, phoneHeader));

  expect(screen.queryByRole('button', { name: 'Ask Roadie' })).toBeNull();
});
