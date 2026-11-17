// @vitest-environment jsdom

// The one toaster in the root layout: whatever a caller shows, its tone decides
// how urgently it is announced and how long it stays.

import { createElement as h } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { Toaster } from './toast';

const route = vi.hoisted(() => ({ pathname: '/library' }));
vi.mock('next/navigation', () => ({ usePathname: () => route.pathname }));

beforeEach(() => {
  vi.useFakeTimers();
  route.pathname = '/library';
});

afterEach(() => {
  act(() => toast.dismiss());
  cleanup();
  vi.useRealTimers();
});

function show(call: () => void) {
  act(call);
  // Radix writes its announcement two animation frames after the toast mounts.
  act(() => vi.advanceTimersByTime(50));
}

function announcement(message: string) {
  return screen
    .getAllByRole('status')
    .find((node) => node.getAttribute('aria-live') && node.textContent?.includes(message));
}

function wait(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}

describe('Toaster', () => {
  it.each([
    ['error', 'assertive'],
    ['warning', 'assertive'],
    ['success', 'polite'],
    ['info', 'polite'],
  ] as const)('announces a %s toast %sly', (tone, urgency) => {
    render(h(Toaster));
    const message = `A ${tone} happened.`;

    show(() => toast[tone](message));

    expect(screen.getByText(message)).toBeTruthy();
    expect(announcement(message)?.getAttribute('aria-live')).toBe(urgency);
  });

  it('closes success and info after 4 s', () => {
    render(h(Toaster));
    show(() => toast.success('Profile saved.'));
    show(() => toast.info('Removed from your Library.'));

    wait(3_800);
    expect(shownToasts()).toHaveLength(2);
    wait(300);
    expect(shownToasts()).toEqual([]);
  });

  it('closes a warning after 8 s', () => {
    render(h(Toaster));
    show(() => toast.warning('Saved, but the cover is still processing.'));

    wait(7_900);
    expect(shownToasts()).toHaveLength(1);
    wait(200);
    expect(shownToasts()).toEqual([]);
  });

  it('keeps an error until it is closed', () => {
    render(h(Toaster));
    show(() => toast.error('Delete failed: Offline.'));

    wait(60_000);
    expect(shownToasts()).toHaveLength(1);

    act(() => screen.getByRole('button', { name: 'Close notification' }).click());
    expect(shownToasts()).toEqual([]);
  });

  it('closes errors on a route change and leaves timed toasts running', () => {
    const view = render(h(Toaster));
    show(() => toast.error('Delete failed: Offline.'));
    show(() => toast.success('Session deleted.'));

    route.pathname = '/';
    view.rerender(h(Toaster));

    expect(shownToasts().map((shown) => shown.message)).toEqual(['Session deleted.']);
    wait(4_100);
    expect(shownToasts()).toEqual([]);
  });

  it('shows its title and its link', () => {
    render(h(Toaster));

    show(() =>
      toast.warning('New music is paused for today.', {
        title: 'Daily limit reached',
        link: { label: 'Cost settings', href: '/settings/costs' },
      }),
    );

    expect(screen.getByText('Daily limit reached')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Cost settings' }).getAttribute('href')).toBe(
      '/settings/costs',
    );
  });
});
