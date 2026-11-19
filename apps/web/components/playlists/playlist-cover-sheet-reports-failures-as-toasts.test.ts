// @vitest-environment jsdom

// The Playlist cover sheet: a failed cover action floats above the sheet, and a
// failed upload floats above the crop dialog, said once, with the dialog still
// open on its framing. The cover status failing to load is the sheet's own
// content, so it stays in the sheet.

import { createElement as h, useEffect, useRef } from 'react';
import type { PlaylistSummaryItem } from '@liedmotif/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  playlistCoverStatus,
  regeneratePlaylistCover,
  uploadPlaylistCover,
  type PlaylistCoverStatusData,
} from '@/lib/http/api-client';
import { shownToasts, toast } from '@/lib/toast';
import { Toaster } from '@/components/ui/toast';
import { AppChromeContext, type AppChromeContextValue } from '@/components/app-chrome-context';
import { PlaylistCoverSheet } from './playlist-cover-sheet';

vi.mock('next/navigation', () => ({ usePathname: () => '/library' }));
vi.mock('@/lib/http/api-client', () => ({
  playlistCoverStatus: vi.fn(),
  regeneratePlaylistCover: vi.fn(),
  selectPlaylistCover: vi.fn(),
  deletePlaylistCover: vi.fn(),
  uploadPlaylistCover: vi.fn(),
}));
vi.mock('@/lib/media/crop-image', () => ({
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
// The cropper measures a loaded image, which jsdom never loads: report a frame
// as soon as it mounts.
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
  // jsdom implements no pointer capture.
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.releasePointerCapture = () => {};
  // The crop dialog's zoom slider measures itself.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  act(() => toast.dismiss());
  cleanup();
  vi.clearAllMocks();
});

const PLAYLIST = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Focus Nights',
  coverImageId: null,
  mosaicCoverImageIds: [],
} as unknown as PlaylistSummaryItem;

const STATUS: PlaylistCoverStatusData = {
  coverImageId: null,
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
  history: [],
  peopleReferencesAvailable: false,
  promptEnhancement: { llmConfigured: false, active: false },
};

const CHROME = { viewerRole: 'admin' } as AppChromeContextValue;

const OFFLINE = { ok: false as const, error: { code: 'internal_error', message: 'Offline.' } };

function openSheet() {
  const onClose = vi.fn();
  render(
    h(
      AppChromeContext.Provider,
      { value: CHROME },
      h(PlaylistCoverSheet, { playlist: PLAYLIST, open: true, onClose, onCoverChanged: vi.fn() }),
      h(Toaster),
    ),
  );
  return { onClose };
}

describe('PlaylistCoverSheet — failures', () => {
  it('floats a failed Generate above the sheet, and a retry that starts clears it', async () => {
    vi.mocked(playlistCoverStatus).mockResolvedValue({ ok: true, data: STATUS });
    vi.mocked(regeneratePlaylistCover)
      .mockResolvedValueOnce(OFFLINE as never)
      .mockResolvedValueOnce({
        ok: true,
        data: { outcome: 'started', coverGenerationId: 'cover-generation-1' },
      });
    const { onClose } = openSheet();
    const generate = await screen.findByTestId('cover-generate');
    await waitFor(() => expect((generate as HTMLButtonElement).disabled).toBe(false));

    await act(async () => fireEvent.click(generate));

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'error', message: 'Offline.' }),
    ]);
    expect(screen.getAllByText('Offline.')).toHaveLength(1);
    expect(screen.getByTestId('cover-sheet')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(screen.getByTestId('cover-generate')));

    expect(shownToasts()).toEqual([]);
  });

  it('says a failed upload once, above the crop dialog, which stays open', async () => {
    vi.mocked(playlistCoverStatus).mockResolvedValue({ ok: true, data: STATUS });
    vi.mocked(uploadPlaylistCover).mockResolvedValue(OFFLINE as never);
    openSheet();
    await screen.findByTestId('cover-upload');

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const photo = new File(['png'], 'photo.png', { type: 'image/png' });
    await act(async () => fireEvent.change(input, { target: { files: [photo] } }));
    const confirm = await screen.findByTestId('image-crop-confirm');
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    await act(async () => fireEvent.click(confirm));

    await waitFor(() =>
      expect(shownToasts()).toEqual([
        expect.objectContaining({ tone: 'error', message: 'Offline.' }),
      ]),
    );
    expect(screen.getAllByText('Offline.')).toHaveLength(1);
    expect(screen.getByTestId('image-crop-dialog')).toBeTruthy();
  });

  it('keeps a cover status that failed to load in the sheet, not in a toast', async () => {
    vi.mocked(playlistCoverStatus).mockResolvedValue(OFFLINE as never);
    openSheet();

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Couldn’t load the cover status: Offline.',
    );
    expect(shownToasts()).toEqual([]);
  });
});
