// @vitest-environment jsdom
import { act, createElement } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelativeTime } from './relative-time';

const iso = '2026-08-11T12:00:00.000Z';
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
});

describe('RelativeTime', () => {
  it("shows the reader's clock after hydration, not the server render's", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-08-11T12:06:00.000Z'));
    const container = document.createElement('div');
    container.innerHTML = renderToString(createElement(RelativeTime, { iso }));
    expect(container.textContent).toBe('6 min ago');

    // The reader opens the page days after it was rendered.
    vi.setSystemTime(Date.parse('2026-08-17T12:06:00.000Z'));
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => {
      root = hydrateRoot(container, createElement(RelativeTime, { iso }));
    });

    expect(container.textContent).toBe('6 days ago');
  });

  it('renders the same text on the server as the formatter', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-08-11T15:00:00.000Z'));
    const container = document.createElement('div');
    container.innerHTML = renderToString(createElement(RelativeTime, { iso }));
    expect(container.textContent).toBe('3 hr ago');
  });
});
