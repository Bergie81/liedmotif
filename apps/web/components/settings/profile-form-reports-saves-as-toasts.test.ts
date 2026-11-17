// @vitest-environment jsdom

// The Profile page reports what its saves and its confirm link did as toasts,
// so the form never moves. A refusal the server pins on a field stays under
// that field.

import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ListenerProfile } from '@liedmotif/db';
import { makeApiError } from '@liedmotif/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { ProfileForm } from './profile-form';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  toast.dismiss();
});

const PROFILE: ListenerProfile = {
  name: 'Thomas',
  email: 'thomas@example.test',
  city: '',
  country: '',
  artistName: '',
  description: '',
};

/** The profile routes, answering each request with the next of `answers`. */
function serve(...answers: Response[]) {
  const fetchMock = vi.fn(async () => answers.shift()!);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function saved(extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: true, profile: PROFILE, ...extra });
}

function renderForm(emailConfirmed: boolean | null = null) {
  render(h(ProfileForm, { initial: PROFILE, role: 'admin', emailConfirmed }));
}

const saveButton = () => screen.getByRole('button', { name: 'Save profile' }) as HTMLButtonElement;

/** Waits until the one toast on screen is this one. */
async function expectToast(tone: string, message: string) {
  await waitFor(() => expect(shownToasts()).toEqual([expect.objectContaining({ tone, message })]));
}

describe('saving the profile', () => {
  it('says the profile was saved', async () => {
    serve(saved());
    renderForm();

    fireEvent.click(saveButton());

    await expectToast('success', 'Profile saved.');
  });

  it('says where the confirm link went when the address moved', async () => {
    serve(saved({ confirmLinkSent: true }));
    renderForm();

    fireEvent.click(saveButton());

    await expectToast('success', 'Profile saved. A confirm link went to thomas@example.test.');
  });

  it('warns when the profile saved but the confirm link could not be sent', async () => {
    serve(saved({ confirmLinkSent: false }));
    renderForm();

    fireEvent.click(saveButton());

    await expectToast(
      'warning',
      'Profile saved, but the confirm link could not be sent. Use Send confirm link to try again.',
    );
  });

  it('reports a failed save, and clears it once saving again succeeds', async () => {
    serve(Response.json({ ok: false, error: 'Could not save profile.' }, { status: 500 }), saved());
    renderForm();

    fireEvent.click(saveButton());
    await expectToast('error', 'Could not save profile.');
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());

    await expectToast('success', 'Profile saved.');
  });

  it('keeps a refusal about a field under that field', async () => {
    serve(Response.json({ ok: false, error: 'That artist name is too long.' }, { status: 400 }));
    renderForm();

    fireEvent.click(saveButton());

    await screen.findByText('That artist name is too long.');
    expect(shownToasts()).toEqual([]);
  });
});

describe('sending a confirm link', () => {
  it('says the link was sent', async () => {
    serve(Response.json({ ok: true, data: {} }));
    renderForm(false);

    fireEvent.click(screen.getByRole('button', { name: 'Send confirm link' }));

    await expectToast('success', 'Confirm link sent. Open it within 24 hours.');
  });

  it('says to wait when too many links went out', async () => {
    serve(Response.json(makeApiError('rate_limited', 'Too many requests.'), { status: 429 }));
    renderForm(false);

    fireEvent.click(screen.getByRole('button', { name: 'Send confirm link' }));

    await expectToast('error', 'Too many confirm links. Wait a few minutes, then try again.');
  });
});
