// @vitest-environment jsdom

// A profile photo that could not be changed is reported as a toast; the line
// under the buttons keeps saying which images fit.

import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { AvatarUploader } from './avatar-uploader';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  toast.dismiss();
});

function serve(...answers: Response[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => answers.shift()!),
  );
}

it('reports a photo that could not be removed, and clears it once removing succeeds', async () => {
  serve(
    Response.json(
      { ok: false, error: { message: 'Could not update the photo.' } },
      { status: 500 },
    ),
    Response.json({ ok: true, data: { imageUrl: null } }),
  );
  render(h(AvatarUploader, { name: 'Thomas', initialImageUrl: '/avatar.webp' }));

  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

  await waitFor(() =>
    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'error', message: 'Could not update the photo.' }),
    ]),
  );
  expect(screen.getByText(/JPEG, PNG, or WebP/)).toBeTruthy();

  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

  await waitFor(() => expect(shownToasts()).toEqual([]));
});
