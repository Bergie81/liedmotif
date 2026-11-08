// @vitest-environment jsdom

// The primitive behind every failure message: whatever a caller passes, the
// failure look is never separated from its screen-reader announcement.

import { createElement as h, type ComponentProps } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AlertBanner } from './design-system';

afterEach(cleanup);

const MESSAGE = 'Could not save that change.';

it('announces its message as an alert', () => {
  render(h(AlertBanner, null, MESSAGE));

  expect(screen.getByRole('alert').textContent).toBe(MESSAGE);
});

it('stays an alert when a caller passes another role', () => {
  const props = { role: 'status', children: MESSAGE } as ComponentProps<typeof AlertBanner>;
  render(h(AlertBanner, props));

  expect(screen.getByRole('alert').textContent).toBe(MESSAGE);
  expect(screen.queryByRole('status')).toBeNull();
});

it('passes a test id through to the alert', () => {
  const props = { 'data-testid': 'create-error', children: MESSAGE } as ComponentProps<
    typeof AlertBanner
  >;
  render(h(AlertBanner, props));

  expect(screen.getByTestId('create-error')).toBe(screen.getByRole('alert'));
});
