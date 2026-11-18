// @vitest-environment jsdom

// A key can pass its Test while the vendor still refuses images for the
// account. The Cover images card keeps that cause in view as an inline alert,
// a state that stays until it is fixed, not a toast that floats away.

import { createElement as h } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { ProviderCard } from './provider-card';

afterEach(() => {
  cleanup();
  toast.dismiss();
});

function renderCard(accountAlert: string | null) {
  render(
    h(ProviderCard, {
      icon: null,
      name: 'Gemini',
      requirement: 'optional',
      source: 'Database',
      description: 'Generates Session and Playlist Covers.',
      accountAlert,
    }),
  );
}

it('shows the account cause inline as an alert, not a toast', () => {
  renderCard('Google needs billing turned on for image models.');

  expect(screen.getByRole('alert').textContent).toBe(
    'Google needs billing turned on for image models.',
  );
  expect(shownToasts()).toEqual([]);
});

it('shows no alert while the account is fine', () => {
  renderCard(null);

  expect(screen.queryByRole('alert')).toBeNull();
});
