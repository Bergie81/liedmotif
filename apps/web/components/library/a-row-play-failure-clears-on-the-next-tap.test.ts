// @vitest-environment jsdom

// A row that would not play says so in a toast; the next tap on a row takes
// it away, and a second refusal replaces it instead of stacking.

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';

const transport = vi.hoisted(() => ({ refusal: null as string | null }));
vi.mock('@/components/player/use-play-session-track', () => ({
  usePlaySessionTrack: (onError: (message: string) => void) => ({
    playViaSession: async () => {
      if (transport.refusal) onError(transport.refusal);
    },
    busyTrackId: null,
    transportRowPreview: { trackId: null, state: 'paused' },
  }),
}));

const { useTrackRowPlayback } = await import('./use-track-row-playback');

afterEach(() => {
  cleanup();
  toast.dismiss();
  transport.refusal = null;
});

const ROW = {
  id: 'track-1',
  originSessionId: 'session-1',
  audioUrl: '/api/audio/track-1',
  title: 'Track',
  generatedArtistName: null,
  coverImageId: null,
};

const shownErrors = () =>
  shownToasts().flatMap((shown) => (shown.tone === 'error' ? [shown.message] : []));

it('clears a refused play on the next tap, and replaces it with a different refusal', async () => {
  const { result } = renderHook(() => useTrackRowPlayback('library-play'));
  transport.refusal = 'Couldn’t play: Offline.';
  await act(async () => result.current.playRow(ROW));
  expect(shownErrors()).toEqual(['Couldn’t play: Offline.']);

  transport.refusal = 'Couldn’t play: The Session is gone.';
  await act(async () => result.current.playRow(ROW));
  expect(shownErrors()).toEqual(['Couldn’t play: The Session is gone.']);

  transport.refusal = null;
  await act(async () => result.current.playRow(ROW));
  expect(shownErrors()).toEqual([]);
});
