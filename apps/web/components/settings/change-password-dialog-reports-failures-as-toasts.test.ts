// @vitest-environment jsdom

// The change-password dialog reports a failed change, reset link or confirm
// link as a toast that floats above it, and the dialog stays open under it.
// What a finished step says stays in the dialog with its Done button, and a
// password that breaks a rule is marked on its field.

import { createElement as h } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { Toaster } from '@/components/ui/toast';
import { ChangePasswordButton } from './change-password-dialog';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/settings/profile',
}));

beforeAll(() => {
  // jsdom implements no pointer capture.
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.releasePointerCapture = () => {};
});

afterEach(() => {
  act(() => toast.dismiss());
  cleanup();
  vi.unstubAllGlobals();
});

/** Answers each request in turn with the next of `answers`. */
function stubAnswers(...answers: Array<{ status: number; body: unknown }>) {
  const queue = [...answers];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const answer = queue.shift() ?? { status: 500, body: {} };
      return Response.json(answer.body, { status: answer.status });
    }),
  );
}

const failure = (message: string, status = 400) => ({
  status,
  body: { ok: false, error: { message } },
});
const success = (data: unknown = {}) => ({ status: 200, body: { ok: true, data } });

function shown() {
  return shownToasts().map(({ tone, message }) => ({ tone, message }));
}

function openDialog(emailConfirmed: boolean | null) {
  render(
    h(
      'div',
      null,
      h(ChangePasswordButton, { email: 'thomas@example.com', emailConfirmed }),
      h(Toaster),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));
  return screen.getByTestId('change-password-dialog');
}

function fillPasswords(next: string) {
  const field = (label: string) => screen.getByLabelText(label);
  fireEvent.change(field('Current password'), { target: { value: 'Old-Password-41' } });
  fireEvent.change(field('New password'), { target: { value: next } });
  fireEvent.change(field('Confirm new password'), { target: { value: next } });
}

const submit = () =>
  fireEvent.click(
    screen.getAllByRole('button', { name: 'Change Password' }).find((b) => b.closest('form'))!,
  );

/** A tap as a pointer, then the focus and click it brings. */
function tap(target: HTMLElement) {
  fireEvent.pointerDown(target, { button: 0 });
  fireEvent.pointerUp(target, { button: 0 });
  target.focus();
  fireEvent.click(target);
}

describe('change-password dialog — failures as toasts', () => {
  it('floats a failed change above the dialog, which a tap on the toast leaves open', async () => {
    stubAnswers(failure('The current password is wrong.'));
    openDialog(null);

    fillPasswords('Correct-Horse-42');
    submit();

    const message = await screen.findByText('The current password is wrong.');
    expect(shown()).toEqual([{ tone: 'error', message: 'The current password is wrong.' }]);
    // Radix arms its outside-tap listener a tick after the layer mounts.
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    tap(message.closest('li') as HTMLElement);

    expect(screen.getByTestId('change-password-dialog')).toBeTruthy();
    expect(screen.getByLabelText('Current password')).toBeTruthy();
  });

  it('clears the failure once a retry succeeds and keeps the Done step in the dialog', async () => {
    stubAnswers(failure('Too many attempts.', 429), success());
    openDialog(null);

    fillPasswords('Correct-Horse-42');
    submit();
    await waitFor(() => expect(shown()).toHaveLength(1));
    submit();

    expect(
      await screen.findByText('Password changed. Every other browser is signed out.'),
    ).toBeTruthy();
    expect(shown()).toEqual([]);
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('marks a password that breaks a rule on its field and sends nothing', () => {
    stubAnswers();
    openDialog(null);

    fillPasswords('short');
    submit();

    const field = screen.getByLabelText('New password');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(fetch).not.toHaveBeenCalled();
    expect(shown()).toEqual([]);
  });

  it('reports a refused reset link as a toast', async () => {
    stubAnswers(failure('Slow down.', 429));
    openDialog(true);

    fireEvent.click(screen.getByRole('button', { name: 'Send Link' }));

    await waitFor(() =>
      expect(shown()).toEqual([
        { tone: 'error', message: 'Too many reset links. Wait a few minutes, then try again.' },
      ]),
    );
    expect(screen.getByTestId('change-password-dialog')).toBeTruthy();
  });

  it('reports a failed confirm link as a toast and keeps a sent one in the dialog', async () => {
    stubAnswers(failure('Mail is down.', 500), success());
    openDialog(false);

    fireEvent.click(screen.getByRole('button', { name: 'Send Confirm Link' }));
    await waitFor(() => expect(shown()).toEqual([{ tone: 'error', message: 'Mail is down.' }]));
    fireEvent.click(screen.getByRole('button', { name: 'Send Confirm Link' }));

    expect(await screen.findByText('Confirm link sent. Open it within 24 hours.')).toBeTruthy();
    expect(shown()).toEqual([]);
  });
});
