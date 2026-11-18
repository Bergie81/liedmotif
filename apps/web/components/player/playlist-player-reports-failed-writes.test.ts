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
import { showPlayerError } from './player-error-toast';
import { PlaylistNowPlaying } from './playlist-now-playing';

const api = vi.hoisted(() => ({ removePlaylistTrack: vi.fn() }));
const provider = vi.hoisted(() => ({ engagePlaylist: vi.fn(), release: vi.fn() }));

vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/api-client')>()),
  removePlaylistTrack: api.removePlaylistTrack,
}));
vi.mock('./player-provider', () => ({
  usePlayerContext: () => ({
    engage: vi.fn(),
    engagePlaylist: provider.engagePlaylist,
    release: provider.release,
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
  provider.engagePlaylist.mockReset();
  provider.release.mockReset();
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
  soleMemberDeletedTrackCount: 0,
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

function showPlaylist(items: PlaylistMemberItem[] = MEMBERS) {
  const player = {
    ...initialPlaybackControllerState(),
    status: 'playing',
    currentTrack: CURRENT_TRACK,
    getPlaybackSample: () => ({ positionSeconds: 12, durationSeconds: 180, playbackRate: 1 }),
    peekNeighbors: () => ({ next: null, previous: null }),
    advancePastDeletedTrack: vi.fn(),
  } as unknown as PlaybackControllerApi;
  const engaged = (members: PlaylistMemberItem[]): LivePlayback => ({
    source: {
      kind: 'playlist',
      playlist: PLAYLIST,
      items: members,
      startTrackId: null,
      foreign: false,
    },
    session: null,
    player,
    coldStartBeganAt: TIMESTAMP,
  });
  // One engagement's membership: every engagement brings its own.
  const members = [...items];
  const view = render(h(PlaylistNowPlaying, { playback: engaged(members), playlist: PLAYLIST }), {
    wrapper: AppShell,
  });
  /** A fresh engagement of the same Playlist, as Play on it again starts one. */
  const engageAgain = (fresh: PlaylistMemberItem[]) =>
    view.rerender(h(PlaylistNowPlaying, { playback: engaged(fresh), playlist: PLAYLIST }));
  /** The player page left and opened again while the same engagement plays on. */
  const reopen = () => {
    view.unmount();
    render(h(PlaylistNowPlaying, { playback: engaged(members), playlist: PLAYLIST }), {
      wrapper: AppShell,
    });
  };
  return Object.assign(player, { engageAgain, reopen });
}

function openOptions() {
  fireEvent.click(screen.getAllByRole('button', { name: 'Playlist and Track options' })[0]!);
  return within(screen.getByRole('dialog'));
}

const FAILED_FAVORITE = 'Favorite failed — this track was not starred. Try again.';

const shownErrors = () =>
  shownToasts().flatMap((shown) => (shown.tone === 'error' ? [shown.message] : []));

it('shows a player write that did not land as an error toast, which stays up over the options', () => {
  showPlaylist();
  showPlayerError(PLAYLIST.id, 'favorite', FAILED_FAVORITE);

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
  showPlaylist();
  showPlayerError(PLAYLIST.id, 'favorite', FAILED_FAVORITE);

  fireEvent.click(openOptions().getByTestId('player-remove-from-playlist'));
  await act(async () => {});

  expect(shownErrors()).toEqual([
    FAILED_FAVORITE,
    'Remove failed — the track stays in the playlist. The server is away.',
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

it('takes a removed Track out of the playing list without engaging the Playlist again', async () => {
  api.removePlaylistTrack.mockResolvedValueOnce({ ok: true, data: {} });
  const player = showPlaylist();

  fireEvent.click(openOptions().getByTestId('player-remove-from-playlist'));
  await act(async () => {});

  expect(provider.engagePlaylist).not.toHaveBeenCalled();
  expect(provider.release).not.toHaveBeenCalled();
  expect(player.advancePastDeletedTrack).toHaveBeenCalledWith('track-1');
  fireEvent.click(screen.getByTestId('player-queue'));
  const list = within(screen.getByTestId('playlist-queue'));
  expect(list.queryByText('Night Drive')).toBeNull();
  expect(list.getByText('Morning')).toBeTruthy();
});

it('ends playback on the Playlist page when the last playable Track is removed', async () => {
  api.removePlaylistTrack.mockResolvedValueOnce({ ok: true, data: {} });
  const player = showPlaylist([MEMBERS[0]!, { ...MEMBERS[1]!, audioUrl: null }]);

  fireEvent.click(openOptions().getByTestId('player-remove-from-playlist'));
  await act(async () => {});

  expect(provider.release).toHaveBeenCalledTimes(1);
  expect(provider.engagePlaylist).not.toHaveBeenCalled();
  expect(player.advancePastDeletedTrack).not.toHaveBeenCalled();
});

it('keeps a removed Track out of the list when the player page opens again', async () => {
  api.removePlaylistTrack.mockResolvedValueOnce({ ok: true, data: {} });
  const player = showPlaylist();

  fireEvent.click(openOptions().getByTestId('player-remove-from-playlist'));
  await act(async () => {});
  player.reopen();

  fireEvent.click(screen.getByTestId('player-queue'));
  const list = within(screen.getByTestId('playlist-queue'));
  expect(list.queryByText('Night Drive')).toBeNull();
  expect(list.getByText('Morning')).toBeTruthy();
});

it('lists a removed Track again once a fresh engagement of the Playlist carries it', async () => {
  api.removePlaylistTrack.mockResolvedValueOnce({ ok: true, data: {} });
  const player = showPlaylist();

  fireEvent.click(openOptions().getByTestId('player-remove-from-playlist'));
  await act(async () => {});
  // Added back, then the Playlist is played again while the player stays open.
  player.engageAgain([...MEMBERS]);

  fireEvent.click(screen.getByTestId('player-queue'));
  const list = within(screen.getByTestId('playlist-queue'));
  expect(list.getByText('Night Drive')).toBeTruthy();
  expect(list.getByText('Morning')).toBeTruthy();
});
