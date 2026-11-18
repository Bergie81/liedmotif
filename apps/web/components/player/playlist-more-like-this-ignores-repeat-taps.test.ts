// @vitest-environment jsdom

// More Like This from a Playlist creates a Session that buys its initial fill,
// and the row closes the sheet with nothing on the page showing the request.
// Reopening the sheet and tapping again before the first request settles must
// not create a second paid Session; once it settles, a new tap goes through.

import { createElement as h, type ReactNode } from 'react';
import type { PlaylistMemberItem, PlaylistSummaryItem } from '@liedmotif/shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { AppChromeContext, type AppChromeContextValue } from '@/components/app-chrome-context';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { PlayableTrack } from './playable-track';
import {
  initialPlaybackControllerState,
  type PlaybackControllerApi,
} from './playback-controller-api';
import type { LivePlayback } from './player-provider';
import { PlaylistNowPlaying } from './playlist-now-playing';
import { closeCreationRefusal, shownCreationRefusal } from '@/components/create/creation-refusal';
import { shownToasts, toast } from '@/lib/toast';

const api = vi.hoisted(() => ({ moreLikeThis: vi.fn() }));

vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/api-client')>()),
  moreLikeThis: api.moreLikeThis,
}));
vi.mock('./player-provider', () => ({
  usePlayerContext: () => ({
    engage: vi.fn(),
    engagePlaylist: vi.fn(),
    release: vi.fn(),
    beginOtherMusic: () => Promise.resolve(true),
    sleepTimer: { endsAt: null, start: vi.fn(), cancel: vi.fn() },
  }),
  usePlayerActions: () => ({}),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
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
  api.moreLikeThis.mockReset();
  closeCreationRefusal();
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

function showPlaylist() {
  const player = {
    ...initialPlaybackControllerState(),
    status: 'playing',
    currentTrack: {
      queueItemId: 'track-1',
      trackId: 'track-1',
      title: 'Night Drive',
      genreTags: [],
      downloadable: true,
    } as unknown as PlayableTrack,
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

async function tapMoreLikeThis() {
  fireEvent.click(screen.getAllByRole('button', { name: 'Playlist and Track options' })[0]!);
  fireEvent.click(within(screen.getByRole('dialog')).getByTestId('playlist-more-like-this'));
  await act(async () => {});
}

it('sends one More Like This while the first is still in flight', async () => {
  let settle: (result: unknown) => void = () => {};
  api.moreLikeThis.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
  api.moreLikeThis.mockResolvedValue({ ok: false, error: { message: 'Refused.' } });
  showPlaylist();

  await tapMoreLikeThis();
  await tapMoreLikeThis();

  expect(api.moreLikeThis).toHaveBeenCalledTimes(1);

  await act(async () => settle({ ok: false, error: { message: 'Refused.' } }));
  await tapMoreLikeThis();

  expect(api.moreLikeThis).toHaveBeenCalledTimes(2);
});

it('opens the blocked dialog, not an error, when the new Session has no headroom', async () => {
  const message = 'A new Session needs 5 Tracks; you have 4 left today.';
  api.moreLikeThis.mockResolvedValue({
    ok: false,
    error: { code: 'session_headroom_blocked', message, retryable: false },
  });
  showPlaylist();

  await tapMoreLikeThis();

  expect(shownCreationRefusal()).toEqual({ kind: 'headroom', message });
  expect(shownToasts()).toEqual([]);
});
