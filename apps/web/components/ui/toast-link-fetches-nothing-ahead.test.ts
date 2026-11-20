// @vitest-environment jsdom

// A toast reads only what the browser already has: its link loads its page when
// it is followed, never ahead of the tap.

import { createElement as h, type ReactNode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { toast } from '@/lib/toast';
import { Toaster } from './toast';

vi.mock('next/navigation', () => ({ usePathname: () => '/library' }));
vi.mock('next/link', () => ({
  default: ({ prefetch, children, ...props }: { prefetch?: boolean; children?: ReactNode }) =>
    h('a', { ...props, 'data-prefetch': String(prefetch) }, children),
}));

afterEach(() => {
  act(() => toast.dismiss());
  cleanup();
});

it('does not prefetch the page its link goes to', async () => {
  render(h(Toaster));

  act(() =>
    toast.warning('New Music is paused for today.', {
      link: { label: 'Cost settings', href: '/settings/costs' },
    }),
  );

  const link = await screen.findByRole('link', { name: 'Cost settings' });
  expect(link.getAttribute('data-prefetch')).toBe('false');
});
