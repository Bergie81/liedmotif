// @vitest-environment jsdom

// The library/search kebab's Delete Track act: danger row behind a confirm
// dialog; the sheet only reports the confirmed intent — the owning surface
// performs the API call and the row removal.

import { createElement as h } from 'react';
import type { TrackSummary } from '@liedmotif/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sheet } from '@/components/ui/sheet';
import { startFileDownload } from '@/lib/downloads';
import { TrackOptionsSheet } from './track-options-sheet';

vi.mock('@/lib/downloads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/downloads')>()),
  startFileDownload: vi.fn(),
}));

afterEach(cleanup);

const TRACK = {
  id: 'track-1',
  title: 'Nachtfahrt',
  durationSeconds: 180,
  coverImageId: null,
  audioUrl: '/api/tracks/track-1/audio',
  savedAt: '2026-07-20T10:00:00.000Z',
  favoritedAt: null,
  dislikedAt: null,
  inCuratedPlaylist: false,
  downloadable: true,
  originSessionTitle: 'Late Drive',
} as unknown as TrackSummary & { originSessionTitle: string | null };

function renderSheet(onDelete = vi.fn(), track = TRACK) {
  render(
    h(
      Sheet,
      { open: true },
      h(TrackOptionsSheet, {
        track,
        busyAction: null,
        onUnsave: vi.fn(),
        onOpenSavePicker: vi.fn(),
        onToggleFavorite: vi.fn(),
        onMoreLikeThis: vi.fn(),
        onPlay: vi.fn(),
        onDelete,
      }),
    ),
  );
  return onDelete;
}

describe('TrackOptionsSheet — Delete Track', () => {
  it('opens a confirm dialog and only deletes on confirm', async () => {
    const onDelete = renderSheet();
    fireEvent.click(screen.getByTestId('library-delete-track'));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
  });

  it('commits nothing when the dialog is dismissed', () => {
    const onDelete = renderSheet();
    fireEvent.click(screen.getByTestId('library-delete-track'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe('TrackOptionsSheet — retention rows', () => {
  it('offers the picker once, and Remove from Library only on a Durable Track', () => {
    renderSheet();

    expect(screen.getByText('Add to Playlist')).toBeTruthy();
    expect(screen.getByText('Remove from Library')).toBeTruthy();
    expect(screen.queryByText('Save Track')).toBeNull();
  });

  it('drops the Remove row for a Track that is in no Playlist', () => {
    renderSheet(vi.fn(), { ...TRACK, savedAt: null });

    expect(screen.getByText('Add to Playlist')).toBeTruthy();
    expect(screen.queryByText('Remove from Library')).toBeNull();
  });

  // The same question the player header's control answers, on the surface the
  // Library, Search and Playlist detail all reach this sheet from.
  it('marks Add to Playlist for a Track already filed into a curated Playlist', () => {
    renderSheet(vi.fn(), { ...TRACK, inCuratedPlaylist: true });

    // The footnote is upper-cased in CSS, so the source case is what renders here.
    expect(screen.getByTestId('library-add-to-playlist').textContent).toContain('In a Playlist');
  });

  it('leaves Add to Playlist unmarked for a Track that is only starred', () => {
    // Favorite sets `savedAt` too, so a row lit from that flag would claim this
    // Track had been filed into Playlists the owner never picked.
    renderSheet(vi.fn(), { ...TRACK, favoritedAt: TRACK.savedAt, inCuratedPlaylist: false });

    expect(screen.getByTestId('library-add-to-playlist').textContent).not.toContain(
      'In a Playlist',
    );
  });
});

describe('TrackOptionsSheet — Download Track', () => {
  it('triggers the download route for a downloadable track', () => {
    renderSheet();
    fireEvent.click(screen.getByTestId('library-download-track'));
    expect(startFileDownload).toHaveBeenCalledWith('/api/tracks/track-1/download');
  });

  it('disables the row while the local final is not stored yet', () => {
    renderSheet(vi.fn(), { ...TRACK, downloadable: false });
    expect((screen.getByTestId('library-download-track') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('TrackOptionsSheet — a Track that could not be kept', () => {
  const FAILED = { ...TRACK, status: 'failed', audioUrl: null, downloadable: false } as const;

  it('offers no play, no star and no download, and says why', () => {
    renderSheet(vi.fn(), FAILED);

    const row = (label: string) => screen.getByText(label).closest('button') as HTMLButtonElement;
    expect(row('Play now').disabled).toBe(true);
    expect(row('Add to Favorites').disabled).toBe(true);
    const download = screen.getByTestId('library-download-track') as HTMLButtonElement;
    expect(download.disabled).toBe(true);
    expect(download.textContent).toContain('Could not be kept');
  });

  it('can still leave Favorites, the Library and be deleted', () => {
    renderSheet(vi.fn(), { ...FAILED, favoritedAt: TRACK.savedAt });

    const row = (label: string) => screen.getByText(label).closest('button') as HTMLButtonElement;
    expect(row('Remove from Favorites').disabled).toBe(false);
    expect(row('Remove from Library').disabled).toBe(false);
    expect((screen.getByTestId('library-delete-track') as HTMLButtonElement).disabled).toBe(false);
  });
});
