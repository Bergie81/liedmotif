// @vitest-environment jsdom

// Opening and closing the Assistant, by pointer and by keyboard: where focus
// goes, what Escape does, and what the launcher is while the panel is open.

import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AssistantDock } from './assistant-dock';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** jsdom has no media queries: say which side of the `desk` breakpoint the window is on. */
function renderDock({ desk, launcherHidden }: { desk: boolean; launcherHidden?: boolean }) {
  vi.stubGlobal(
    'matchMedia',
    () => ({ matches: desk, addEventListener: () => {}, removeEventListener: () => {} }) as never,
  );
  return render(
    h(
      TooltipProvider,
      null,
      h('button', { type: 'button' }, 'Something on the page'),
      h(AssistantDock, { launcherHidden }),
    ),
  );
}

it('opens from the launcher with a greeting and questions to start from', () => {
  renderDock({ desk: true });
  expect(screen.queryByRole('dialog')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Ask Mo' }));

  const panel = screen.getByRole('dialog', { name: 'Mo' });
  expect(panel.textContent).toContain("Hi, I'm Mo. Ask me anything about your Liedmotif.");
  expect(screen.getByRole('button', { name: 'What does New music do?' })).toBeTruthy();
});

it('puts the cursor in the question field when it opens beside the page', () => {
  renderDock({ desk: true });

  fireEvent.click(screen.getByRole('button', { name: 'Ask Mo' }));

  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Ask Mo' }));
});

it('moves focus into the panel, not the field, when it covers the page', () => {
  renderDock({ desk: false });

  fireEvent.click(screen.getByRole('button', { name: 'Ask Mo' }));

  expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Mo' }));
});

it('turns the launcher into the close button while the sidebar is open', () => {
  renderDock({ desk: true });
  fireEvent.click(screen.getByRole('button', { name: 'Ask Mo' }));
  expect(document.documentElement.classList.contains('assistant-open')).toBe(true);

  // The panel's own header carries a close button of the same name; the
  // launcher is the one outside the panel.
  const launcher = screen
    .getAllByRole('button', { name: 'Close Mo' })
    .find((button) => !screen.getByRole('dialog').contains(button))!;
  fireEvent.click(launcher);

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.documentElement.classList.contains('assistant-open')).toBe(false);
  expect(screen.getByRole('button', { name: 'Ask Mo' })).toBeTruthy();
});

it('closes on Escape and hands focus back to the launcher', async () => {
  renderDock({ desk: true });
  const launcher = screen.getByRole('button', { name: 'Ask Mo' });
  fireEvent.click(launcher);

  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Ask Mo' }), { key: 'Escape' });

  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(launcher));
});

it('leaves Escape to the page while focus is in the page beside the sidebar', () => {
  renderDock({ desk: true });
  fireEvent.click(screen.getByRole('button', { name: 'Ask Mo' }));
  const pageButton = screen.getByRole('button', { name: 'Something on the page' });

  pageButton.focus();
  fireEvent.keyDown(pageButton, { key: 'Escape' });

  expect(screen.getByRole('dialog', { name: 'Mo' })).toBeTruthy();
});

it('keeps the conversation while the panel is closed', () => {
  renderDock({ desk: true });
  fireEvent.click(screen.getByRole('button', { name: 'Ask Mo' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Ask Mo' }), {
    target: { value: 'How do I invite' },
  });

  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Ask Mo' }), { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Ask Mo' }));

  expect((screen.getByRole('textbox', { name: 'Ask Mo' }) as HTMLTextAreaElement).value).toBe(
    'How do I invite',
  );
});

it('shows no launcher on a page that keeps controls in that corner', () => {
  renderDock({ desk: false, launcherHidden: true });

  expect(screen.queryByRole('button', { name: 'Ask Mo' })).toBeNull();
});

it('asks a suggested question and can stop the answer from the field', () => {
  // The request never settles: the answer stays "being written".
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
  renderDock({ desk: true });
  fireEvent.click(screen.getByRole('button', { name: 'Ask Mo' }));

  fireEvent.click(screen.getByRole('button', { name: 'What does New music do?' }));

  expect(screen.getByRole('log').textContent).toContain('What does New music do?');
  expect(screen.getByRole('status').textContent).toContain('Mo is looking it up');
  expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Stop the answer' }));

  // Nothing was answered: the question is back in the field, ready to send again.
  const field = screen.getByRole('textbox', { name: 'Ask Mo' }) as HTMLTextAreaElement;
  expect(field.value).toBe('What does New music do?');
  expect(document.activeElement).toBe(field);
  expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
});
