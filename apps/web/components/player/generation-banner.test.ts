// @vitest-environment jsdom

// What the generation banner tells the listener, and the one way out it can
// offer. A Session blocked before its first Track must never claim to be
// playing ready tracks, and when nothing will lift that block, the banner is
// where the escape hatch belongs.
//
// The copy rules themselves belong to the pure mapping's own tests; each case
// here pins one live controller field reaching it — the queue projection, the
// in-flight generation, the cost-limit scope, the server's safe message.

import { createElement as h, type ReactElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeleteSessionAction,
  GenerationBanner,
  type GenerationBannerPlayer,
} from './generation-banner';

afterEach(cleanup);

const IN_FLIGHT = {
  stage: 'generating',
  submittedAt: '2026-08-02T10:00:00.000Z',
  trackTitle: null,
} as const;

function player(overrides: Partial<GenerationBannerPlayer> = {}): GenerationBannerPlayer {
  return {
    generationStatus: 'provider_error',
    generationStatusScope: null,
    statusMessageSafe: null,
    queueLength: 2,
    pendingGeneration: null,
    ...overrides,
  };
}

function banner(
  overrides: Partial<GenerationBannerPlayer> = {},
  action?: ReactElement,
): HTMLElement | null {
  render(h(GenerationBanner, { player: player(overrides), action }));
  return screen.queryByTestId('generation-status');
}

function deleteControl(): HTMLElement | null {
  return screen.queryByRole('button', { name: /Delete Session/ });
}

const SESSION_TITLE = 'Rainy desk focus';

const DELETE_ACTION = h(DeleteSessionAction, {
  sessionTitle: SESSION_TITLE,
  onDelete: async () => {},
});

/** Render the action on its own and open its confirmation. */
function openDeleteConfirm(onDelete: () => Promise<void>): void {
  render(h(DeleteSessionAction, { sessionTitle: SESSION_TITLE, onDelete }));
  act(() => deleteControl()!.click());
}

describe('generation banner', () => {
  it('surfaces nothing while generation is healthy', () => {
    expect(banner({ generationStatus: 'ok' })).toBeNull();
  });

  it('keeps the steady-state copy for a session that has tracks', () => {
    expect(banner()?.textContent).toContain('playing your ready tracks');
  });

  it('names the absence for a session that has no tracks yet', () => {
    const status = banner({ queueLength: 0 });
    expect(status?.textContent).toContain('No Tracks yet');
    expect(status?.textContent).not.toContain('ready tracks');
    // Severity still reads at a glance.
    expect(status?.className).toContain('border-warn/40');
  });

  it('offers the way out inside the status region once the session is stuck', () => {
    const status = banner({ queueLength: 0 }, DELETE_ACTION);
    const control = deleteControl();
    expect(control).not.toBeNull();
    expect(status?.contains(control)).toBe(true);
  });

  it('never offers the way out while a generation is still in flight', () => {
    banner({ queueLength: 0, pendingGeneration: IN_FLIGHT }, DELETE_ACTION);
    expect(deleteControl()).toBeNull();
  });

  it('never offers the way out to a session that has tracks', () => {
    banner({ queueLength: 2 }, DELETE_ACTION);
    expect(deleteControl()).toBeNull();
  });

  it('renders no control when the caller passes no action', () => {
    expect(banner({ queueLength: 0 })).not.toBeNull();
    expect(deleteControl()).toBeNull();
  });

  it('points the admin at cost limits and a member at their own budget', () => {
    banner({ generationStatus: 'repeat_cost_limit', queueLength: 0 });
    expect(screen.getByRole('link', { name: 'Adjust cost limits' }).getAttribute('href')).toBe(
      '/settings/limits',
    );
    cleanup();

    banner({
      generationStatus: 'repeat_cost_limit',
      generationStatusScope: 'member',
      queueLength: 0,
    });
    expect(screen.getByRole('link', { name: 'See your budget' }).getAttribute('href')).toBe(
      '/settings/my-budget',
    );
  });

  it('prefers the server’s safe message over the zero-track copy', () => {
    const status = banner({ queueLength: 0, statusMessageSafe: 'The provider refused the job.' });
    expect(status?.textContent).toContain('The provider refused the job.');
  });
});

describe('delete session action', () => {
  it('asks before it destroys anything, naming the Session', () => {
    const onDelete = vi.fn(async () => {});

    openDeleteConfirm(onDelete);

    const dialog = screen.getByTestId('confirm-dialog');
    expect(dialog.textContent).toContain(SESSION_TITLE);
    expect(dialog.textContent).toContain('The Session stops first');
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('runs the stop-then-delete handler once confirmed', async () => {
    const onDelete = vi.fn(async () => {});

    openDeleteConfirm(onDelete);
    await act(async () => {
      screen.getByTestId('confirm-dialog-confirm').click();
    });

    expect(onDelete).toHaveBeenCalledOnce();
  });
});
