// @vitest-environment jsdom

// The Tracks-left readout counts in the user's unit, so exactly one left is
// "1 Track", for the eye and for a screen reader alike.

import { createElement as h } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HeadroomLink } from './app-navigation';

afterEach(cleanup);

const ONE_LEFT = {
  remainingTracks: 1,
  remainingRatio: 0.05,
  window: 'day',
  critical: true,
} as const;

describe('the headroom readout with one Track left', () => {
  it('reads "1 Track left" on the compact chip', () => {
    render(h(HeadroomLink, { headroom: ONE_LEFT, href: '/settings/limits', compact: true }));
    const link = screen.getByRole('link');
    expect(link.getAttribute('aria-label')).toBe('Generation headroom: 1 track left today');
    // The figure and its unit are separate flex items, spaced by the layout.
    expect(link.textContent).toBe('1track left today');
  });

  it('reads "1 Track left" on the rail', () => {
    render(h(HeadroomLink, { headroom: ONE_LEFT, href: '/settings/limits' }));
    const link = screen.getByRole('link');
    expect(link.getAttribute('aria-label')).toBe('Generation headroom: 1 track left today');
    expect(link.textContent).toBe('1track left today');
  });
});
