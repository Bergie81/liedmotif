// @vitest-environment jsdom

// Recent Sessions failing to load must not leave a screen reader user waiting on
// a list that will never arrive, and the way back must keep working.

import { createElement as h, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ResumableSessionsState } from '@/components/sessions/use-resumable-sessions';
import { RecentSessions } from './recent-sessions';

vi.mock('@/components/sessions/session-tracks-sheet', () => ({
  SessionTracksProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/sessions/session-card', () => ({
  SessionCard: () => null,
  SessionCardLastActiveDetails: () => null,
}));

afterEach(cleanup);

const LOAD_FAILURE = 'Could not load your Sessions.';

function failedToLoad(retry: () => void): ResumableSessionsState {
  return {
    items: null,
    pinned: [],
    activeSession: null,
    error: LOAD_FAILURE,
    nextCursor: null,
    loadingMore: false,
    loadMore: async () => {},
    removeItem: () => {},
    updateItem: () => {},
    setPinned: async () => false,
    retry,
  };
}

it('announces a failed load as an alert carrying its message', () => {
  render(h(RecentSessions, { state: failedToLoad(() => {}) }));

  expect(screen.getByRole('alert').textContent).toContain(LOAD_FAILURE);
});

it('retries the load from the alert', () => {
  const retry = vi.fn();
  render(h(RecentSessions, { state: failedToLoad(retry) }));

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

  expect(retry).toHaveBeenCalledTimes(1);
});
