// @vitest-environment jsdom

// The Offline Library opens because a page navigation failed, and a device can
// have a network while the server stays out of reach. Its "back online" offer
// must wait until the server itself answers, or it sends the listener straight
// back to a page that cannot load.

import { act, createElement as h } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OfflineLibrary } from './offline-library';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('offers the app only once the server answers, not when the browser merely has a network', async () => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
  );
  render(h(OfflineLibrary));

  expect(await screen.findByText(/No connection/)).toBeTruthy();
  expect(screen.queryByText(/back online/)).toBeNull();

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}')),
  );
  act(() => {
    window.dispatchEvent(new Event('online'));
  });
  expect(await screen.findByText(/back online/)).toBeTruthy();
});
