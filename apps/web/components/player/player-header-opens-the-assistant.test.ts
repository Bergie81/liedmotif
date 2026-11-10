// @vitest-environment jsdom

// The Player keeps its seek bar and transport where the Assistant's floating
// launcher sits, so the shell shows none there. The Player's own headers carry
// the launcher instead: the control row beside the cover on a wide screen, the
// page header on a phone.

import { createElement as h, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { AppChromeContext, type AppChromeContextValue } from '@/components/app-chrome-context';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ShellAssistant } from '@/tests/helpers/shell-assistant';
import { PlayerHeader } from './player-header';
import { PlayerMobileHeader } from './player-mobile-header';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

beforeAll(() => {
  // jsdom has no media queries: the window is on the `desk` side, where the
  // panel opens beside the page.
  vi.stubGlobal(
    'matchMedia',
    () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }) as never,
  );
});

afterEach(cleanup);

/** The app shell on the Player: it shows no launcher of its own. */
function Shell({ children }: { children: ReactNode }) {
  return h(
    TooltipProvider,
    null,
    h(ShellAssistant, { links: { appPaths: [], docsPages: [] }, launcherHidden: true }, children),
  );
}

const header = h(PlayerHeader, {
  statusLabel: 'PLAYING',
  title: 'Nachtfahrt',
  subtitle: 'Liedmotif',
  announcement: 'PLAYING: Nachtfahrt.',
  options: null,
});

it('opens the Assistant from the Player header', () => {
  render(h(Shell, null, header));
  expect(screen.queryByRole('dialog')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Ask Mo' }));

  expect(screen.getByRole('dialog', { name: 'Mo' })).toBeTruthy();
});

it('closes the sidebar from the same header button', () => {
  render(h(Shell, null, header));
  fireEvent.click(screen.getByRole('button', { name: 'Ask Mo' }));

  // The panel's own header carries a close button of the same name.
  const launcher = screen
    .getAllByRole('button', { name: 'Close Mo' })
    .find((button) => !screen.getByRole('dialog').contains(button))!;
  fireEvent.click(launcher);

  expect(screen.queryByRole('dialog')).toBeNull();
});

it('hands focus back to the header button when the panel closes', async () => {
  render(h(Shell, null, header));
  const launcher = screen.getByRole('button', { name: 'Ask Mo' });
  fireEvent.click(launcher);

  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Ask Mo' }), { key: 'Escape' });

  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(launcher));
});

it('opens the Assistant from the phone header of the Player', () => {
  const chrome = {
    listener: { name: 'Thea', email: 'thea@example.com', artistName: null, imageUrl: null },
    themeMode: 'night',
    onToggleThemeMode: () => {},
  } as unknown as AppChromeContextValue;
  render(
    h(
      Shell,
      null,
      h(
        AppChromeContext.Provider,
        { value: chrome },
        h(PlayerMobileHeader, { title: 'Now Playing your Session', action: null }),
      ),
    ),
  );

  fireEvent.click(screen.getByRole('button', { name: 'Ask Mo' }));

  expect(screen.getByRole('dialog', { name: 'Mo' })).toBeTruthy();
});

it('shows no Assistant button to a viewer without the Assistant', () => {
  render(h(TooltipProvider, null, header));

  expect(screen.queryByRole('button', { name: 'Ask Mo' })).toBeNull();
});
