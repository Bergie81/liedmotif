// @vitest-environment jsdom

// Nothing in the Playlist cover sheet changes the Playlist's cover until the
// owner presses "Use this cover": an uploaded image and the mosaic preview on
// the stage first, exactly like a generated or earlier cover.

import { createElement as h, useEffect, useRef } from 'react';
import type { PlaylistSummaryItem } from '@liedmotif/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  playlistCoverStatus,
  selectPlaylistCover,
  uploadPlaylistCover,
  type PlaylistCoverStatusData,
} from '@/lib/api-client';
import { AppChromeContext, type AppChromeContextValue } from '@/components/app-chrome-context';
import { PlaylistCoverSheet } from './playlist-cover-sheet';

vi.mock('next/navigation', () => ({ usePathname: () => '/library' }));
vi.mock('@/lib/api-client', () => ({
  playlistCoverStatus: vi.fn(),
  regeneratePlaylistCover: vi.fn(),
  selectPlaylistCover: vi.fn(),
  deletePlaylistCover: vi.fn(),
  uploadPlaylistCover: vi.fn(),
}));
vi.mock('@/lib/crop-image', () => ({
  preparePickedImage: async () => ({
    kind: 'crop',
    source: {
      url: 'blob:picked',
      size: { width: 2000, height: 2000 },
      image: {},
      pristine: true,
      release: () => {},
    },
  }),
  renderCroppedFile: async () => new File(['jpeg'], 'upload.jpg', { type: 'image/jpeg' }),
}));
vi.mock('react-easy-crop', () => ({
  default: function Cropper({
    onCropComplete,
  }: {
    onCropComplete: (area: unknown, pixels: unknown) => void;
  }) {
    const report = useRef(onCropComplete);
    useEffect(() => {
      const frame = { x: 0, y: 0, width: 2000, height: 2000 };
      report.current(frame, frame);
    }, []);
    return null;
  },
}));

beforeAll(() => {
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.releasePointerCapture = () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const CURRENT = '00000000-0000-4000-8000-000000000001';
const UPLOADED = '00000000-0000-4000-8000-000000000002';

const PLAYLIST = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Focus Nights',
  coverImageId: CURRENT,
  mosaicCoverImageIds: [],
} as unknown as PlaylistSummaryItem;

function entry(coverImageId: string, style: string, isCurrent = false) {
  return { coverImageId, isCurrent, style, createdAt: '2026-11-18T10:00:00.000Z' };
}

const STATUS: PlaylistCoverStatusData = {
  coverImageId: CURRENT,
  generating: false,
  latestRegeneration: null,
  usage: {
    usedDay: 0,
    limitDay: 10,
    usedMonth: 0,
    limitMonth: 50,
    remaining: 10,
    oneTime: false,
    enabled: true,
    providerConfigured: true,
    sunoFallbackActive: false,
  },
  history: [entry(CURRENT, 'minimal', true)],
  peopleReferencesAvailable: false,
  promptEnhancement: { llmConfigured: false, active: false },
};

/** What the big stage shows: the current cover or a previewed candidate. */
function showing() {
  return screen.getByTestId('playlist-cover-stage').getAttribute('data-showing');
}

async function openSheet() {
  const onCoverChanged = vi.fn();
  render(
    h(
      AppChromeContext.Provider,
      { value: { viewerRole: 'admin' } as AppChromeContextValue },
      h(PlaylistCoverSheet, { playlist: PLAYLIST, open: true, onClose: vi.fn(), onCoverChanged }),
    ),
  );
  await screen.findByTestId('playlist-cover-upload');
  await waitFor(() => expect(playlistCoverStatus).toHaveBeenCalled());
  return { onCoverChanged };
}

describe('PlaylistCoverSheet — applies only on confirm', () => {
  it('an uploaded image previews on the stage and only Use this cover applies it', async () => {
    vi.mocked(playlistCoverStatus).mockResolvedValue({ ok: true, data: STATUS });
    vi.mocked(uploadPlaylistCover).mockImplementation(async () => {
      // The upload lands in the history; the Playlist keeps its cover.
      vi.mocked(playlistCoverStatus).mockResolvedValue({
        ok: true,
        data: { ...STATUS, history: [entry(UPLOADED, 'uploaded'), ...STATUS.history] },
      });
      return { ok: true, data: { coverImageId: UPLOADED } };
    });
    vi.mocked(selectPlaylistCover).mockResolvedValue({
      ok: true,
      data: { coverImageId: UPLOADED },
    });
    const { onCoverChanged } = await openSheet();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const photo = new File(['png'], 'photo.png', { type: 'image/png' });
    await act(async () => fireEvent.change(input, { target: { files: [photo] } }));
    const crop = await screen.findByTestId('image-crop-confirm');
    await waitFor(() => expect((crop as HTMLButtonElement).disabled).toBe(false));
    await act(async () => fireEvent.click(crop));

    await waitFor(() => expect(showing()).toBe('upload'));
    expect(onCoverChanged).not.toHaveBeenCalled();
    expect(selectPlaylistCover).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('playlist-cover-confirm'));
    await waitFor(() => expect(selectPlaylistCover).toHaveBeenCalledWith(PLAYLIST.id, UPLOADED));
    expect(onCoverChanged).toHaveBeenCalledWith(UPLOADED);
  });

  it('the Mosaic View tile previews the mosaic and only Use this cover clears back to it', async () => {
    vi.mocked(playlistCoverStatus).mockResolvedValue({ ok: true, data: STATUS });
    vi.mocked(selectPlaylistCover).mockResolvedValue({ ok: true, data: { coverImageId: null } });
    const { onCoverChanged } = await openSheet();

    fireEvent.click(await screen.findByTestId('playlist-cover-clear'));
    expect(showing()).toBe('mosaic');
    expect(selectPlaylistCover).not.toHaveBeenCalled();
    expect(onCoverChanged).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('playlist-cover-confirm'));
    await waitFor(() => expect(selectPlaylistCover).toHaveBeenCalledWith(PLAYLIST.id, null));
    expect(onCoverChanged).toHaveBeenCalledWith(null);
  });
});
