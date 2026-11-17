// @vitest-environment jsdom

// A write that did not land says so in a toast from the Playlist surface, the
// way it does from the Session surface, and stops saying so once a retry lands.

import { createElement as h, type ReactNode } from 'react';
import type { PlaylistMemberItem, PlaylistSummaryItem } from '@liedmotif/shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { AppChromeContext, type AppChromeContextValue } from '@/components/app-chrome-context';
import { TooltipProvider } from '@/components/ui/tooltip';
import { shownToasts, toast } from '@/lib/toast';
import type { PlayableTrack } from './playable-track';
import {
  initialPlaybackControllerState,
  type PlaybackControllerApi,
} from './playback-controller-api';
import type { LivePlayback } from './player-provider';
import { PlaylistNowPlaying } from './playlist-now-playing';

const api = vi.hoisted(() => ({ removePlaylistTrack: vi.fn() }));

vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/api-client')>()),
  removePlaylistTrack: api.removePlaylistTrack,
}));
vi.mock('./player-provider', () => ({
  usePlayerContext: () => ({
    engage: vi.fn(),
    engagePlaylist: vi.fn(),
    release: vi.fn(),
    beginOtherMusic: vi.fn(),
    sleepTimer: { endsAt: null, start: vi.fn(), cancel: vi.fn() },
  }),
  usePlayerActions: () => ({}),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
// Lazily loaded and needs the app shell: left real, it throws whenever its import
// settles before the test ends.
vi.mock('./regenerate-cover-dialog', () => ({ RegenerateCoverDialog: () => null }));

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal('fetch', () => new Promise(() => undefined));
});

afterEach(() => {
  cleanup();
  api.removePlaylistTrack.mockReset();
  toast.dismiss();
});

const TIMESTAMP = '2026-11-07T10:00:00.000Z';

const PLAYLIST: PlaylistSummaryItem = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Focus Nights',
  kind: 'user',
  listedInPlaylists: true,
  trackCount: 2,
  totalDurationSeconds: 360,
  downloadableTrackCount: 2,
  coverImageId: null,
  mosaicCoverImageIds: [],
  soleMemberTrackCount: 0,
  containsTrack: null,
  sharedAt: null,
  pinnedAt: null,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const CURRENT_TRACK = {
  queueItemId: 'track-1',
  trackId: 'track-1',
  title: 'Night Drive',
  genreTags: [],
  downloadable: true,
} as unknown as PlayableTrack;

const MEMBERS = [
  { id: 'track-1', title: 'Night Drive', audioUrl: '/api/tracks/track-1/audio' },
  { id: 'track-2', title: 'Morning', audioUrl: '/api/tracks/track-2/audio' },
] as PlaylistMemberItem[];

const CHROME: AppChromeContextValue = {
  listener: { name: 'Thomas', email: 'thomas@example.com', artistName: null, imageUrl: null },
  viewerRole: 'admin',
  ownVoiceOffered: false,
  themeMode: 'night',
  onToggleThemeMode: () => {},
  fetchChrome: () => new Promise(() => undefined),
};

function AppShell({ children }: { children?: ReactNode }) {
  return h(TooltipProvider, null, h(AppChromeContext.Provider, { value: CHROME }, children));
}

function showPlaylist(actionError: string | null = null) {
  const player = {
    ...initialPlaybackControllerState(),
    status: 'playing',
    currentTrack: CURRENT_TRACK,
    actionError,
    getPlaybackSample: () => ({ positionSeconds: 12, durationSeconds: 180, playbackRate: 1 }),
    peekNeighbors: () => ({ next: null, previous: null }),
  } as unknown as PlaybackControllerApi;
  const playback: LivePlayback = {
    source: {
      kind: 'playlist',
      playlist: PLAYLIST,
      items: MEMBERS,
      startTrackId: null,
      foreign: false,
    },
    session: null,
    player,
    coldStartBeganAt: TIMESTAMP,
  };
  render(h(PlaylistNowPlaying, { playback, playlist: PLAYLIST }), { wrapper: AppShell });
}

function openOptions() {
  fireEvent.click(screen.getAllByRole('button', { name: 'Playlist and Track options' })[0]!);
  return within(screen.getByRole('dialog'));
}

const FAILED_FAVORITE = 'Favorite failed — this track was not starred. Try again.';

const shownErrors = () =>
  shownToasts().flatMap((shown) => (shown.tone === 'error' ? [shown.message] : []));

it('shows a player write that did not land as an error toast, which stays up over the options', () => {
  showPlaylist(FAILED_FAVORITE);

  expect(shownErrors()).toEqual([FAILED_FAVORITE]);
  expect(screen.queryByRole('alert')).toBeNull();

  openOptions();

  expect(shownErrors()).toEqual([FAILED_FAVORITE]);
});

it('shows a refused Remove beside a player notice that is still up', async () => {
  api.removePlaylistTrack.mockResolvedValueOnce({
    ok: false,
    error: { message: 'The server is away.' },
  });
  showPlaylist(FAILED_FAVORITE);

  fireEvent.click(openOptions().getByTestId('player-remove-from-playlist'));
  await act(async () => {});

  expect(shownErrors()).toEqual([
    `${FAILED_FAVORITE} Remove failed — the track stays in the playlist. The server is away.`,
  ]);
});

it('drops a failed Remove once the retry lands', async () => {
  api.removePlaylistTrack.mockResolvedValueOnce({
    ok: false,
    error: { message: 'The server is away.' },
  });
  api.removePlaylistTrack.mockResolvedValueOnce({ ok: true, data: {} });
  showPlaylist();

  const removeRow = () => openOptions().getByTestId('player-remove-from-playlist');

  fireEvent.click(removeRow());
  await act(async () => {});
  expect(shownErrors()).toEqual([
    'Remove failed — the track stays in the playlist. The server is away.',
  ]);

  fireEvent.click(removeRow());
  await act(async () => {});

  expect(shownErrors()).toEqual([]);
});
