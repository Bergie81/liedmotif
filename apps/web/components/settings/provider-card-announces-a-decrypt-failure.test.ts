// @vitest-environment jsdom

// An Admin using a screen reader must hear that a stored credential can no
// longer be decrypted, because the only way forward is re-entering it.

import { createElement as h } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ProviderCard } from './provider-card';

afterEach(cleanup);

it('announces a credential it cannot decrypt as an alert carrying its message', () => {
  render(
    h(ProviderCard, {
      icon: null,
      name: 'Suno',
      requirement: 'required',
      source: 'Database',
      description: 'Generates the music.',
      decryptError: true,
    }),
  );

  expect(screen.getByRole('alert').textContent).toBe(
    'The stored value cannot be decrypted. Re-enter it after restoring the instance credential-encryption key.',
  );
});

// Fields `.env` leaves unset stay editable, so the banner speaks only for the locked ones.
it('says the fields .env sets are locked, without calling the whole card read-only', () => {
  render(
    h(ProviderCard, {
      icon: null,
      name: 'Suno',
      requirement: 'required',
      source: 'Environment',
      description: 'Generates the music.',
      environmentManaged: true,
    }),
  );

  const banner = screen.getByText(/server environment/);
  expect(banner.textContent).toContain('locked');
  expect(banner.textContent).not.toContain('cannot be edited here');
});
