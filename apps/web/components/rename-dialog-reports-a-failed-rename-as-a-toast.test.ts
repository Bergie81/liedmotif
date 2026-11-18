// @vitest-environment jsdom

// A rename the server refuses floats above the naming dialog, which stays open
// with the typed name so the owner can try again; closing the toast leaves the
// dialog where it was, and a rename that then lands clears the failure.

import { createElement as h } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { Toaster } from '@/components/ui/toast';
import { RenameDialog } from './rename-dialog';

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

function openDialog(onRename: (name: string) => Promise<string | null>) {
  const onClose = vi.fn();
  render(
    h(
      'div',
      null,
      h(RenameDialog, {
        heading: 'Rename Session',
        currentName: 'Calm',
        maxLength: 60,
        onRename,
        onClose,
      }),
      h(Toaster),
    ),
  );
  fireEvent.change(screen.getByTestId('rename-input'), { target: { value: 'Calmer' } });
  return { onClose };
}

const save = () => act(async () => fireEvent.click(screen.getByTestId('rename-save')));

describe('rename dialog — a refused rename', () => {
  it('floats the failure above the dialog, and closing it leaves the dialog open', async () => {
    const { onClose } = openDialog(async () => 'Rename failed: Offline.');

    await save();

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'error', message: 'Rename failed: Offline.' }),
    ]);
    expect(screen.queryByTestId('rename-error')).toBeNull();
    // Radix arms its outside-tap listener a tick after the layer mounts.
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    const close = (await screen.findByText('Rename failed: Offline.'))
      .closest('li')!
      .querySelector('button') as HTMLButtonElement;
    fireEvent.pointerDown(close, { button: 0 });
    fireEvent.click(close);

    await waitFor(() => expect(shownToasts()).toEqual([]));
    expect(screen.getByTestId('rename-dialog')).toBeTruthy();
    expect((screen.getByTestId('rename-input') as HTMLInputElement).value).toBe('Calmer');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('replaces a repeated failure and clears it once a retry lands', async () => {
    const answers = ['Rename failed: Offline.', 'Rename failed: Offline.', null];
    const { onClose } = openDialog(async () => answers.shift() ?? null);

    await save();
    await save();
    expect(shownToasts()).toHaveLength(1);

    await save();

    expect(shownToasts()).toEqual([]);
    expect(onClose).toHaveBeenCalled();
  });

  it('takes the failure away as soon as the retry starts', async () => {
    const answers = [
      Promise.resolve('Rename failed: Offline.'),
      new Promise<null>(() => undefined),
    ];
    openDialog(() => answers.shift()!);

    await save();
    expect(shownToasts()).toHaveLength(1);
    await save();

    expect(shownToasts()).toEqual([]);
  });
});
