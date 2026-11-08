// @vitest-environment jsdom

// The member kebab's Delete Track act: a danger row that never deletes on the
// first tap — the confirm dialog owns the destructive commit, and closing it
// commits nothing.

import { createElement as h } from 'react';
import type { PlaylistMemberItem } from '@liedmotif/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startFileDownload } from '@/lib/downloads';
import { PlaylistTrackSheet } from './playlist-track-sheet';

vi.mock('@/lib/downloads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/downloads')>()),
  startFileDownload: vi.fn(),
}));

afterEach(cleanup);

const ITEM = {
  id: 'track-1',
  position: 0,
  title: 'Nachtfahrt',
  durationSeconds: 180,
  coverImageId: null,
  audioUrl: '/api/tracks/track-1/audio',
  savedAt: '2026-07-20T10:00:00.000Z',
  favoritedAt: null,
  addedAt: '2026-07-21T10:00:00.000Z',
  genreTags: [],
  downloadable: true,
} as unknown as PlaylistMemberItem;

function renderSheet(
  overrides: {
    onDelete?: (item: PlaylistMemberItem) => void;
    item?: PlaylistMemberItem;
    visitor?: boolean;
  } = {},
) {
  const handlers = {
    onClose: vi.fn(),
    onRemove: vi.fn(),
    onAddToPlaylist: vi.fn(),
    onMoreLikeThis: vi.fn(),
    onOpenTrackData: vi.fn(),
    onDelete: overrides.onDelete ?? vi.fn(),
  };
  render(
    h(PlaylistTrackSheet, {
      item: overrides.item ?? ITEM,
      ...(overrides.visitor !== undefined ? { visitor: overrides.visitor } : {}),
      ...handlers,
    }),
  );
  return handlers;
}

describe('PlaylistTrackSheet — Delete Track', () => {
  it('offers a Delete Track row that opens a confirm dialog instead of deleting', () => {
    const handlers = renderSheet();
    fireEvent.click(screen.getByTestId('playlist-delete-track'));
    expect(handlers.onDelete).not.toHaveBeenCalled();
    expect(screen.getByTestId('confirm-dialog')).toBeTruthy();
    expect(screen.getByText(/Permanently delete/)).toBeTruthy();
  });

  it('deletes only on confirm', async () => {
    const onDelete = vi.fn();
    renderSheet({ onDelete });
    fireEvent.click(screen.getByTestId('playlist-delete-track'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(ITEM));
  });

  it('commits nothing when the dialog is dismissed', () => {
    const onDelete = vi.fn();
    renderSheet({ onDelete });
    fireEvent.click(screen.getByTestId('playlist-delete-track'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });
});

describe('PlaylistTrackSheet — foreign tracks', () => {
  const FOREIGN_ITEM = {
    ...ITEM,
    owner: { name: 'Mira Marlowe', artistName: 'Nightowl', imageUrl: null },
  } as unknown as PlaylistMemberItem;

  it('keeps my membership acts on a Shared reference but drops the owner-only rows', () => {
    const handlers = renderSheet({ item: FOREIGN_ITEM });
    // The membership in MY playlist stays mine to remove, and re-filing it is
    // saving a reference again — both live.
    fireEvent.click(screen.getByTestId('playlist-remove-track'));
    expect(handlers.onRemove).toHaveBeenCalledWith(FOREIGN_ITEM);
    expect(screen.getByTestId('playlist-add-track-to-playlist')).toBeTruthy();
    expect(screen.getByTestId('playlist-track-data')).toBeTruthy();
    // Downloading and deleting are the owner's; absent, not disabled.
    expect(screen.queryByTestId('playlist-download-track')).toBeNull();
    expect(screen.queryByTestId('playlist-delete-track')).toBeNull();
  });

  // Foreign seeding: MLT on a foreign track is the
  // reader's own act — live, and labeled as spending THEIR budget (the bare
  // owner description would read as spending the sharer's).
  it('offers More Like This on a foreign track, labeled as spending my budget', () => {
    const handlers = renderSheet({ item: FOREIGN_ITEM });
    const row = screen.getByTestId('playlist-track-more-like-this');
    expect(row.textContent).toContain('your own budget');
    fireEvent.click(row);
    expect(handlers.onMoreLikeThis).toHaveBeenCalledWith(FOREIGN_ITEM);
  });

  it('keeps the owner description on an OWNED track — my own seeding is not re-labeled', () => {
    renderSheet();
    const row = screen.getByTestId('playlist-track-more-like-this');
    expect(row.textContent).toContain('new session');
    expect(row.textContent).not.toContain('your own budget');
  });

  it('offers the visitor view the save-reference row without any curation of the owner playlist', () => {
    const handlers = renderSheet({ visitor: true });
    fireEvent.click(screen.getByTestId('playlist-add-track-to-playlist'));
    expect(handlers.onAddToPlaylist).toHaveBeenCalledWith(ITEM);
    expect(screen.queryByTestId('playlist-remove-track')).toBeNull();
    expect(screen.queryByTestId('playlist-download-track')).toBeNull();
    expect(screen.queryByTestId('playlist-delete-track')).toBeNull();
  });
});

describe('PlaylistTrackSheet — Download Track', () => {
  it('triggers the download route for a downloadable member', () => {
    renderSheet();
    fireEvent.click(screen.getByTestId('playlist-download-track'));
    expect(startFileDownload).toHaveBeenCalledWith('/api/tracks/track-1/download');
  });

  it('disables the row for a member whose local final is not stored yet', () => {
    renderSheet({ item: { ...ITEM, downloadable: false } });
    expect((screen.getByTestId('playlist-download-track') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
