// @vitest-environment jsdom

// A refused save floats above the save picker, which stays open with the
// owner's picks so the save can be tried again; closing the toast leaves the
// picker where it was. The list failing to load stays in the picker.

import { createElement as h } from 'react';
import type { PlaylistSummaryItem } from '@liedmotif/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { Toaster } from '@/components/ui/toast';
import { SaveToPlaylistSheet } from './save-to-playlist-sheet';

const holder = vi.hoisted(() => ({
  loadFails: false,
  answers: [] as Array<'refuse' | 'accept'>,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/library',
}));
vi.mock('@/lib/api-client', () => ({
  getAllPlaylists: async () =>
    holder.loadFails
      ? { ok: false as const, error: { code: 'internal_error', message: 'Offline.' } }
      : { ok: true as const, data: { playlists: [FOCUS], nextCursor: null } },
  applyTrackMemberships: async (input: { trackId: string; playlistIds: string[] }) =>
    holder.answers.shift() === 'refuse'
      ? { ok: false as const, error: { code: 'internal_error', message: 'Offline.' } }
      : {
          ok: true as const,
          data: { trackId: input.trackId, playlistIds: input.playlistIds, flags: {} },
        },
}));

beforeAll(() => {
  // jsdom implements no pointer capture.
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.releasePointerCapture = () => {};
});

afterEach(() => {
  act(() => toast.dismiss());
  cleanup();
  holder.loadFails = false;
  holder.answers = [];
});

const FOCUS = {
  id: 'focus-id',
  name: 'Focus',
  kind: 'user',
  listedInPlaylists: true,
  trackCount: 2,
  containsTrack: false,
  sharedAt: null,
} as PlaylistSummaryItem;

function openPicker() {
  const onClose = vi.fn();
  const onApplied = vi.fn();
  render(
    h(
      'div',
      null,
      h(SaveToPlaylistSheet, {
        track: { id: 'track-1', title: 'Calm', savedAt: null, coverImageId: null },
        onClose,
        onApplied,
      }),
      h(Toaster),
    ),
  );
  return { onClose, onApplied };
}

async function pickFocusAndSave() {
  fireEvent.click(await screen.findByTestId('picker-playlist'));
  await act(async () => fireEvent.click(screen.getByTestId('picker-commit')));
}

describe('save picker — a refused save', () => {
  it('floats the failure above the picker, and closing it leaves the picker open', async () => {
    holder.answers = ['refuse'];
    const { onClose, onApplied } = openPicker();

    await pickFocusAndSave();

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'error', message: 'Saving failed: Offline.' }),
    ]);
    expect(screen.queryByRole('alert')).toBeNull();
    // Radix arms its outside-tap listener a tick after the layer mounts.
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    const close = (await screen.findByText('Saving failed: Offline.'))
      .closest('li')!
      .querySelector('button') as HTMLButtonElement;
    fireEvent.pointerDown(close, { button: 0 });
    fireEvent.click(close);

    await waitFor(() => expect(shownToasts()).toEqual([]));
    expect(screen.getByTestId('save-picker-sheet')).toBeTruthy();
    expect(screen.getByTestId('picker-playlist').getAttribute('aria-checked')).toBe('true');
    expect(onClose).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('clears the failure once a retry lands', async () => {
    holder.answers = ['refuse', 'accept'];
    const { onClose } = openPicker();

    await pickFocusAndSave();
    await act(async () => fireEvent.click(screen.getByTestId('picker-commit')));

    expect(shownToasts()).toEqual([]);
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps a list that failed to load in the picker, not in a toast', async () => {
    holder.loadFails = true;
    openPicker();

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Couldn’t load your playlists: Offline.',
    );
    expect(shownToasts()).toEqual([]);
  });
});
