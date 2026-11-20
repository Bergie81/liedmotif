// @vitest-environment jsdom

// A modal sheet or dialog reads a tap outside its content as "dismiss". A toast
// floats above both, so tapping or closing one must leave the sheet or dialog
// under it open, whether the toast came before it opened or after.

import { createElement as h, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { toast } from '@/lib/toast';
import { Dialog, DialogContent, DialogTitle } from './dialog';
import { Sheet, SheetContent, SheetHeader } from './sheet';
import { Toaster } from './toast';

vi.mock('next/navigation', () => ({ usePathname: () => '/library' }));

beforeAll(() => {
  // jsdom implements no pointer capture.
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.releasePointerCapture = () => {};
});

afterEach(() => {
  act(() => toast.dismiss());
  cleanup();
});

const MESSAGE = 'Saving failed: Offline.';

const surfaces: Array<
  [string, (open: boolean, onOpenChange: (open: boolean) => void) => ReactNode]
> = [
  [
    'sheet',
    (open, onOpenChange) =>
      h(
        Sheet,
        { open, onOpenChange },
        h(SheetContent, { side: 'bottom' }, h(SheetHeader, { title: 'Options' })),
      ),
  ],
  [
    'dialog',
    (open, onOpenChange) =>
      h(Dialog, { open, onOpenChange }, h(DialogContent, null, h(DialogTitle, null, 'Rename'))),
  ],
];

async function shownToast() {
  return (await screen.findByText(MESSAGE)).closest('li') as HTMLElement;
}

/** A tap as a pointer, then the focus and click it brings. */
function tap(target: HTMLElement) {
  fireEvent.pointerDown(target, { button: 0 });
  fireEvent.pointerUp(target, { button: 0 });
  target.focus();
  fireEvent.click(target);
}

// Radix arms its outside-tap listener a tick after the layer mounts.
const armed = () => act(() => new Promise((resolve) => setTimeout(resolve, 10)));

describe.each(surfaces)('a toast over an open %s', (_name, surface) => {
  function renderOpen() {
    const onOpenChange = vi.fn();
    const view = render(
      h('div', null, h('p', null, 'The page'), surface(true, onOpenChange), h(Toaster)),
    );
    return { onOpenChange, view };
  }

  it('still closes on a tap anywhere else', async () => {
    const { onOpenChange } = renderOpen();
    await armed();

    tap(screen.getByText('The page'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('leaves it open when the toast is tapped', async () => {
    const { onOpenChange } = renderOpen();
    act(() => toast.error(MESSAGE));
    const shown = await shownToast();
    await armed();

    tap(shown);

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('leaves it open when the toast is closed', async () => {
    const { onOpenChange } = renderOpen();
    act(() => toast.error(MESSAGE));
    await shownToast();
    await armed();

    // The open modal hides everything outside itself from assistive tech.
    tap(screen.getByRole('button', { name: 'Close Notification', hidden: true }));

    await waitFor(() => expect(screen.queryByText(MESSAGE)).toBeNull());
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('leaves it open when a toast shown before it opened is tapped', async () => {
    const onOpenChange = vi.fn();
    const view = render(h('div', null, surface(false, onOpenChange), h(Toaster)));
    act(() => toast.error(MESSAGE));
    const shown = await shownToast();
    view.rerender(h('div', null, surface(true, onOpenChange), h(Toaster)));
    await armed();

    tap(shown);

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(shown.style.pointerEvents).toBe('auto');
  });
});
