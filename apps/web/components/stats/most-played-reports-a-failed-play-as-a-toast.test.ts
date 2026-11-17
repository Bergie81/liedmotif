// @vitest-environment jsdom

// A Most played row that fails to start its Track says so in a toast, so the
// ranking stays where it is.

import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { MostPlayed } from './most-played';
import type { TrackRow } from './your-stats-model';

vi.mock('@/components/player/use-play-session-track', () => ({
  usePlaySessionTrack: (onError: (message: string) => void) => ({
    playViaSession: async () => {
      onError('Couldn’t load that Track. Please retry.');
      return true;
    },
    busyTrackId: null,
    transportRowPreview: { trackId: null, state: 'idle' },
  }),
}));
vi.mock('@/components/player/cover-art', () => ({ CoverArt: () => null }));

afterEach(() => {
  cleanup();
  toast.dismiss();
});

const ROW: TrackRow = {
  key: 'track-1',
  label: 'Nachtfahrt',
  coverImageId: null,
  plays: '12 plays',
  playCount: 12,
  share: 40,
  action: { kind: 'play', track: { id: 'track-1', originSessionId: 'session-1' } },
};

it('reports a failed play as an error toast and keeps the ranking', async () => {
  render(h(MostPlayed, { rows: [ROW] }));

  fireEvent.click(screen.getByRole('button', { name: 'Play Nachtfahrt' }));

  await waitFor(() =>
    expect(shownToasts()).toEqual([
      expect.objectContaining({
        tone: 'error',
        message: 'Couldn’t load that Track. Please retry.',
      }),
    ]),
  );
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: 'Play Nachtfahrt' })).toBeTruthy();
});
