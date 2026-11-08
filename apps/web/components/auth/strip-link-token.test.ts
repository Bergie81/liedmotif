// @vitest-environment jsdom

// A one-shot token that stays in the address bar outlives the visit: browser
// history keeps it, and a proxy in front logs the path. The page holds it in
// props, and the address bar is left showing only the base path.

import { createElement as h } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StripLinkToken } from './strip-link-token';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderStrip(basePath: string) {
  const rendered = render(h(StripLinkToken, { basePath }));
  act(() => {
    vi.runAllTimers();
  });
  return rendered;
}

describe('StripLinkToken', () => {
  it('drops the token segment from the address bar once the page has settled', () => {
    window.history.replaceState(null, '', '/join/HRMqB0Fa4dhsE9lXbcAqvw');

    renderStrip('/join');

    expect(window.location.pathname).toBe('/join');
  });

  it('overwrites the entry carrying the token instead of burying it', () => {
    window.history.replaceState(null, '', '/reset/HRMqB0Fa4dhsE9lXbcAqvw');
    const entries = window.history.length;

    renderStrip('/reset');

    // A pushed entry would leave the token one Back press away.
    expect(window.history.length).toBe(entries);
  });
});
