// @vitest-environment jsdom

// The My Sessions kebab rows. Download Session triggers the zip route by
// plain navigation, and stays disabled while the session has no tracks (the
// route would 404 a zero-track zip as a rendered page).

import { createElement as h, type ComponentProps } from 'react';
import type { SessionListItem } from '@liedmotif/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sheet } from '@/components/ui/sheet';
import { startFileDownload } from '@/lib/downloads/downloads';
import { SessionOptionsSheet } from './session-options-sheet';

vi.mock('@/lib/downloads/downloads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/downloads/downloads')>()),
  startFileDownload: vi.fn(),
}));

afterEach(cleanup);

const SESSION = {
  id: 'session-1',
  title: 'Late Drive',
  trackCount: 4,
  genreTags: ['lofi'],
} as unknown as SessionListItem;

function renderSheet(
  session = SESSION,
  callbacks: Partial<ComponentProps<typeof SessionOptionsSheet>> = {},
) {
  render(
    h(
      Sheet,
      { open: true },
      h(SessionOptionsSheet, {
        session,
        resuming: false,
        deleting: false,
        converting: false,
        pinning: false,
        onResume: vi.fn(),
        onTogglePin: vi.fn(),
        onRename: vi.fn(),
        onChangeCover: vi.fn(),
        onConvertToPlaylist: vi.fn(),
        onDelete: vi.fn(),
        ...callbacks,
      }),
    ),
  );
}

describe('SessionOptionsSheet — Delete Session', () => {
  it('deletes only from the confirm modal, which names the Session', async () => {
    const onDelete = vi.fn();
    renderSheet(SESSION, { onDelete });
    fireEvent.click(screen.getByTestId('delete-session'));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByTestId('confirm-dialog').textContent).toContain('Late Drive');
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(onDelete).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
  });

  it('cancelling the modal deletes nothing and keeps the options open', () => {
    const onDelete = vi.fn();
    renderSheet(SESSION, { onDelete });
    fireEvent.click(screen.getByTestId('delete-session'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByTestId('delete-session')).toBeTruthy();
  });
});

describe('SessionOptionsSheet — Convert to Playlist', () => {
  it('disables the row for a Session with no Tracks', () => {
    renderSheet({ ...SESSION, trackCount: 0 });
    const row = screen.getByTestId('convert-session-to-playlist') as HTMLButtonElement;
    expect(row.disabled).toBe(true);
  });
});

describe('SessionOptionsSheet — Download Session', () => {
  it('triggers the session zip route', () => {
    renderSheet();
    fireEvent.click(screen.getByTestId('download-session'));
    expect(startFileDownload).toHaveBeenCalledWith('/api/sessions/session-1/download');
  });

  it('disables the row for a session with no tracks', () => {
    renderSheet({ ...SESSION, trackCount: 0 });
    expect((screen.getByTestId('download-session') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('SessionOptionsSheet — Pin Session', () => {
  it('offers Pin for an unpinned Session and Unpin for a pinned one', () => {
    const onTogglePin = vi.fn();
    renderSheet({ ...SESSION, pinned: false }, { onTogglePin });
    fireEvent.click(screen.getByRole('button', { name: /^Pin Session/ }));
    expect(onTogglePin).toHaveBeenCalledOnce();

    cleanup();
    renderSheet({ ...SESSION, pinned: true });
    expect(screen.getByRole('button', { name: /^Unpin Session/ })).toBeTruthy();
  });
});

describe('SessionOptionsSheet — Change Cover Art', () => {
  it('opens the cover dialog for the Session', () => {
    const onChangeCover = vi.fn();
    renderSheet(SESSION, { onChangeCover });
    fireEvent.click(screen.getByTestId('change-session-cover'));
    expect(onChangeCover).toHaveBeenCalledOnce();
  });
});
