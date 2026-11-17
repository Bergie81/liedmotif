// @vitest-environment jsdom

// An action that did not land says so in a toast from the Session surface, and
// stops saying so once a retry lands. Nothing on the page moves for it.

import { createElement as h, type ReactNode } from 'react';
import type { SessionSummary } from '@liedmotif/shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { AppChromeContext, type AppChromeContextValue } from '@/components/app-chrome-context';
import { TooltipProvider } from '@/components/ui/tooltip';
import { closeToast, shownToasts, toast } from '@/lib/toast';
import { NowPlaying } from './now-playing';
import type { PlayableTrack } from './playable-track';
import {
  initialPlaybackControllerState,
  type PlaybackControllerApi,
} from './playback-controller-api';
import type { LivePlayback } from './player-provider';

const api = vi.hoisted(() => ({ deleteTrack: vi.fn() }));

vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/api-client')>()),
  deleteTrack: api.deleteTrack,
}));
vi.mock('./player-provider', () => {
  const context = {
    engage: vi.fn(),
    release: vi.fn(),
    beginOtherMusic: vi.fn(async () => true),
    submitChangeVibe: vi.fn(),
    pending: null,
    vibeChange: { pendingSessionId: null, error: null },
    sleepTimer: { endsAt: null, start: vi.fn(), cancel: vi.fn() },
  };
  return { usePlayerContext: () => context, usePlayerActions: () => context };
});
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
  api.deleteTrack.mockReset();
  toast.dismiss();
});

const TIMESTAMP = '2026-11-07T10:00:00.000Z';

const SESSION: SessionSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'active',
  title: 'Late Rain',
  generationStatus: 'ok',
  generationStatusScope: null,
  sessionMode: 'keep_going',
  coverImageId: null,
  statusMessageSafe: null,
  targetDurationMinutes: null,
  generatedDurationSeconds: 0,
  unknownDurationTrackCount: 0,
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

function nowPlayingFor(actionError: string | null) {
  const player = {
    ...initialPlaybackControllerState(),
    status: 'playing',
    currentTrack: CURRENT_TRACK,
    actionError,
    getPlaybackSample: () => ({ positionSeconds: 12, durationSeconds: 180, playbackRate: 1 }),
    peekNeighbors: () => ({ next: null, previous: null }),
    advancePastDeletedTrack: vi.fn(),
    refreshQueue: vi.fn(),
  } as unknown as PlaybackControllerApi;
  const playback: LivePlayback = {
    source: { kind: 'session', session: SESSION },
    session: SESSION,
    player,
    coldStartBeganAt: TIMESTAMP,
  };
  return h(NowPlaying, {
    playback,
    session: SESSION,
    onSessionChange: () => {},
    onStopped: () => {},
  });
}

/** Renders the Session surface; the returned function hands it a new controller notice. */
function showSession(actionError: string | null = null) {
  const view = render(nowPlayingFor(actionError), { wrapper: AppShell });
  return (next: string | null) => view.rerender(nowPlayingFor(next));
}

const shownErrors = () =>
  shownToasts().flatMap((shown) => (shown.tone === 'error' ? [shown.message] : []));

async function deleteTrackFromOptions() {
  fireEvent.click(screen.getAllByRole('button', { name: 'Session and Track options' })[0]!);
  fireEvent.click(within(screen.getByRole('dialog')).getByTestId('player-delete-track'));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  await act(async () => {});
}

it('shows a player write that did not land as an error toast, not on the page', () => {
  const failed = 'Favorite failed — this track was not starred. Try again.';
  showSession(failed);

  expect(shownErrors()).toEqual([failed]);
  expect(screen.queryByTestId('player-error')).toBeNull();
});

it('shows a refused Delete Track, and drops it once the retry lands', async () => {
  api.deleteTrack.mockResolvedValueOnce({ ok: false, error: { message: 'The server is away.' } });
  api.deleteTrack.mockResolvedValueOnce({ ok: true, data: {} });
  showSession();

  await deleteTrackFromOptions();
  expect(shownErrors()).toEqual(['Delete failed — the track is unchanged. The server is away.']);

  await deleteTrackFromOptions();

  expect(shownErrors()).toEqual([]);
});

it('keeps a closed failure closed when a different one comes and goes', async () => {
  api.deleteTrack.mockResolvedValueOnce({ ok: false, error: { message: 'The server is away.' } });
  const notice = showSession();
  await deleteTrackFromOptions();
  closeToast(shownToasts()[0]!.id);

  const favoriteFailed = 'Favorite failed — this track was not starred. Try again.';
  notice(favoriteFailed);
  expect(shownErrors()).toEqual([favoriteFailed]);

  notice(null);
  expect(shownErrors()).toEqual([]);
});
