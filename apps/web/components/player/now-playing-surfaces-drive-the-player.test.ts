// @vitest-environment jsdom

// What a listener can do on each Now Playing surface, pressed the way they press
// it: a stub player behind the real transport and cover sleeve. Every surface
// fires the same player action from the same control, and each offers only what
// its Playback source can do: the Session shell belongs to a Session,
// and the Offline Library holds nothing that writes to the server.

import { createElement as h, type ReactElement, type ReactNode } from 'react';
import type { PlaylistMemberItem, PlaylistSummaryItem, SessionSummary } from '@liedmotif/shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppChromeContext, type AppChromeContextValue } from '@/components/app-chrome-context';
import { OfflineNowPlaying } from '@/components/offline/offline-now-playing';
import { TooltipProvider } from '@/components/ui/tooltip';
import { NowPlaying } from './now-playing';
import type { PlayableTrack } from './playable-track';
import {
  initialPlaybackControllerState,
  type PlaybackControllerApi,
} from './playback-controller-api';
import type { SourceNoun } from './player-presentation';
import type { EngagedSource, LivePlayback, PlayerContextValue } from './player-provider';
import { PlaylistNowPlaying } from './playlist-now-playing';
import { SERVER_TRACK_MEDIA, TrackMediaProvider, type TrackMedia } from './track-media';

const provider = vi.hoisted(() => ({ context: null as unknown }));

vi.mock('./player-provider', () => ({
  usePlayerContext: () => provider.context,
  usePlayerActions: () => provider.context,
}));
vi.mock('next/navigation', () => {
  const router = { push: vi.fn(), refresh: vi.fn() };
  return { useRouter: () => router };
});
// Lazily loaded and needs the app shell: left real, it throws whenever its import
// settles before the test ends, which makes these tests depend on load timing.
vi.mock('./regenerate-cover-dialog', () => ({ RegenerateCoverDialog: () => null }));
// Supported, so the Available offline row's absence from a surface means something.
vi.mock('@/lib/offline/offline-support', () => ({ offlineSupported: () => true }));
vi.mock('@/lib/offline/device-offline', () => ({
  subscribeOfflineStatus: () => () => undefined,
  offlineStatusSnapshot: () => new Map(),
  deviceOffline: vi.fn(),
}));

beforeAll(() => {
  // Radix measures the slider thumb; jsdom has no layout observer.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // Reduced motion, so titles and chips settle instead of scrambling.
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  // A read nobody answers: a sheet that fetches on open stays in its loading state.
  vi.stubGlobal('fetch', () => new Promise(() => undefined));
  // jsdom implements no pointer capture and no image decoding.
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLImageElement.prototype.decode = () => Promise.resolve();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const noop = () => {};
const TIMESTAMP = '2026-11-07T10:00:00.000Z';

const SESSION: SessionSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'active',
  title: 'Late Rain',
  generationStatus: 'ok',
  generationStatusScope: null,
  sessionMode: 'keep_going',
  coverImageId: 'session-cover',
  statusMessageSafe: null,
  targetDurationMinutes: 60,
  generatedDurationSeconds: 0,
  unknownDurationTrackCount: 0,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const PLAYLIST: PlaylistSummaryItem = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Focus Nights',
  kind: 'user',
  listedInPlaylists: true,
  trackCount: 1,
  totalDurationSeconds: 180,
  downloadableTrackCount: 1,
  coverImageId: null,
  mosaicCoverImageIds: [],
  soleMemberTrackCount: 0,
  containsTrack: null,
  sharedAt: null,
  pinnedAt: null,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const OFFLINE_NAME = 'For the Train';

function track(overrides: Partial<PlayableTrack> = {}): PlayableTrack {
  return {
    queueItemId: 'track-1',
    trackId: 'track-1',
    queueState: 'playing',
    vibeSwitchSetAside: false,
    title: 'Night Drive',
    artist: 'Liedmotif',
    originSessionTitle: 'Late Rain',
    durationSeconds: 180,
    coverImageId: 'track-cover',
    savedAt: null,
    favoritedAt: null,
    inCuratedPlaylist: false,
    genreTags: ['ambient'],
    vocalMode: 'instrumental',
    hasLyrics: false,
    downloadable: true,
    assets: { final: '/api/tracks/track-1/audio', stream: null },
    styleRevision: 1,
    targetBpm: null,
    targetKey: null,
    blendAnalysis: null,
    ...overrides,
  };
}

const VOCAL_TRACK = { vocalMode: 'vocal', hasLyrics: true } as const;

/** The whole controller api, so a surface reading any field of it finds one. Only
 *  the actions are mocks, which makes `fired` the list of what a press did. */
function stubPlayer(overrides: Partial<PlaybackControllerApi> = {}): PlaybackControllerApi {
  return {
    ...initialPlaybackControllerState(),
    currentTrackNumber: null,
    trackCount: 0,
    deckARef: { current: null },
    deckBRef: { current: null },
    loopHeld: false,
    blendEnabled: true,
    blendSettled: true,
    getPlaybackSample: () => ({ positionSeconds: 12, durationSeconds: 180, playbackRate: 1 }),
    peekNeighbors: () => ({
      next: track({ coverImageId: 'next-cover' }),
      previous: track({ coverImageId: 'previous-cover' }),
    }),
    play: vi.fn(),
    pause: vi.fn(),
    skip: vi.fn(),
    back: vi.fn(),
    previous: vi.fn(),
    restart: vi.fn(),
    toggle: vi.fn(),
    dislike: vi.fn(),
    deleteTrack: vi.fn(),
    advancePastDeletedTrack: vi.fn(),
    applyRetentionFlags: vi.fn(),
    toggleFavorite: vi.fn(),
    cyclePlaybackMode: vi.fn(),
    setPlaybackMode: vi.fn(),
    playQueueItem: vi.fn(),
    applyTrackTitle: vi.fn(),
    toggleBlend: vi.fn(),
    seekTo: vi.fn(),
    sectionLoopAvailable: true,
    toggleSectionLoopTool: vi.fn(),
    setSectionLoop: vi.fn(),
    clearSectionLoop: vi.fn(),
    setOutputVolume: vi.fn(),
    refreshQueue: vi.fn(),
    ...overrides,
  };
}

const playingPlayer = (overrides: Partial<PlaybackControllerApi> = {}) =>
  stubPlayer({ status: 'playing', currentTrack: track(), ...overrides });

/** Every player action fired so far, with how many times. */
function fired(player: PlaybackControllerApi): Record<string, number> {
  return Object.fromEntries(
    Object.entries(player).flatMap(([name, value]) =>
      vi.isMockFunction(value) && value.mock.calls.length > 0
        ? [[name, value.mock.calls.length]]
        : [],
    ),
  );
}

const CHROME: AppChromeContextValue = {
  listener: { name: 'Thomas', email: 'thomas@example.com', artistName: null, imageUrl: null },
  viewerRole: 'admin',
  ownVoiceOffered: false,
  themeMode: 'night',
  onToggleThemeMode: noop,
  fetchChrome: () => new Promise(() => undefined),
};

const SEEK_LINE = { kind: 'line', text: 'Rain on the glass', timeSeconds: 42 } as const;

const MEDIA: TrackMedia = {
  ...SERVER_TRACK_MEDIA,
  lyrics: async () => ({
    ok: true,
    data: { state: 'ready', lines: [SEEK_LINE], synced: true, settled: true },
  }),
};

/** What the app shell and the provider hand every surface. */
function AppShell({ children }: { children?: ReactNode }) {
  return h(
    TooltipProvider,
    null,
    h(
      AppChromeContext.Provider,
      { value: CHROME },
      h(TrackMediaProvider, { media: MEDIA, children }),
    ),
  );
}

function mount(
  player: PlaybackControllerApi,
  source: EngagedSource,
  surface: (playback: LivePlayback) => ReactElement,
) {
  const playback: LivePlayback = {
    source,
    session: source.kind === 'session' ? source.session : null,
    player,
    coldStartBeganAt: TIMESTAMP,
  };
  const context: PlayerContextValue = {
    engage: vi.fn(),
    engagePlaylist: vi.fn(),
    engageOffline: vi.fn(),
    release: vi.fn(),
    beginStart: vi.fn(),
    beginOtherMusic: vi.fn(async () => true),
    submitChangeVibe: vi.fn(),
    engagedSource: source,
    playback,
    pending: null,
    vibeChange: { pendingSessionId: null, error: null },
    sleepTimer: { endsAt: null, start: vi.fn(), cancel: vi.fn() },
  };
  provider.context = context;
  render(surface(playback), { wrapper: AppShell });
}

function showOffline(player: PlaybackControllerApi, noun: SourceNoun, onBack: () => void = noop) {
  mount(
    player,
    {
      kind: 'offline',
      key: 'playlist:offline',
      name: OFFLINE_NAME,
      tracks: [],
      startTrackId: null,
    },
    (playback) => h(OfflineNowPlaying, { playback, name: OFFLINE_NAME, noun, onBack }),
  );
}

const TRANSPORT_STATES = [
  // A Play armed while preparing: the toggle would cancel it, and shows the wait.
  { status: 'waiting', playIntentPending: true, toggle: 'Pause', waits: true },
  { status: 'loading', playIntentPending: true, toggle: 'Pause', waits: true },
  // Preparing with nothing asked to play is no wait the listener started.
  { status: 'waiting', playIntentPending: false, toggle: 'Play', waits: false },
  { status: 'loading', playIntentPending: false, toggle: 'Play', waits: false },
  { status: 'playing', playIntentPending: false, toggle: 'Pause', waits: false },
  { status: 'paused', playIntentPending: false, toggle: 'Play', waits: false },
] as const;

interface Surface {
  name: string;
  noun: SourceNoun;
  /** The status line above the title while the player is in each status. */
  statusLine: Record<(typeof TRANSPORT_STATES)[number]['status'], string>;
  /** The queue sheet's accessible name. */
  queueSheet: string;
  /** The art a cover swipe reveals on either side, previous first. */
  swipeArt: [string, string];
  show: (player: PlaybackControllerApi) => void;
}

const SESSION_SURFACE: Surface = {
  name: 'Session',
  noun: 'Session',
  statusLine: {
    waiting: 'Preparing your Session',
    loading: 'Connecting',
    playing: 'Now playing',
    paused: 'Paused',
  },
  queueSheet: 'Late Rain',
  // The Session Cover is shared by all its Tracks.
  swipeArt: ['/api/covers/session-cover', '/api/covers/session-cover'],
  show: (player) =>
    mount(player, { kind: 'session', session: SESSION }, (playback) =>
      h(NowPlaying, { playback, session: SESSION, onSessionChange: noop, onStopped: noop }),
    ),
};

const PLAYLIST_SURFACE: Surface = {
  name: 'Playlist',
  noun: 'Playlist',
  statusLine: {
    waiting: 'Preparing · Playlist',
    loading: 'Connecting · Playlist',
    playing: 'Now playing · Playlist',
    paused: 'Paused · Playlist',
  },
  queueSheet: 'Focus Nights',
  swipeArt: ['/api/covers/previous-cover', '/api/covers/next-cover'],
  show: (player) =>
    mount(
      player,
      {
        kind: 'playlist',
        playlist: PLAYLIST,
        items: [
          {
            id: 'track-1',
            title: 'Night Drive',
            coverImageId: null,
            durationSeconds: 180,
            audioUrl: '/api/tracks/track-1/audio',
          } as PlaylistMemberItem,
        ],
        startTrackId: null,
        foreign: false,
      },
      (playback) => h(PlaylistNowPlaying, { playback, playlist: PLAYLIST }),
    ),
};

const OFFLINE_SURFACE: Surface = {
  name: 'Offline',
  noun: 'Playlist',
  statusLine: {
    waiting: 'Preparing · Offline',
    loading: 'Connecting · Offline',
    playing: 'Now playing · Offline',
    paused: 'Paused · Offline',
  },
  queueSheet: OFFLINE_NAME,
  swipeArt: ['/api/covers/previous-cover', '/api/covers/next-cover'],
  show: (player) => showOffline(player, 'Playlist'),
};

const SURFACES = [SESSION_SURFACE, PLAYLIST_SURFACE, OFFLINE_SURFACE];

function button(name: string | RegExp): HTMLElement {
  return screen.getByRole('button', { name });
}

const press = (name: string | RegExp) => fireEvent.click(button(name));

const BACK = 'Back — restart or previous Track';
const SKIP = 'Skip — direction unchanged';

const TRANSPORT_PRESSES = [
  { control: BACK, status: 'playing', action: 'back' },
  { control: 'Pause', status: 'playing', action: 'toggle' },
  { control: 'Play', status: 'paused', action: 'toggle' },
  { control: SKIP, status: 'playing', action: 'skip' },
] as const;

/** How the toggle looks under this name with nothing to wait for. The wait is
 *  decorative and the button keeps its name through it, so the wait shows only
 *  as a toggle that looks different from this. */
function restingToggle(surface: Surface, name: 'Pause' | 'Play'): string {
  surface.show(
    stubPlayer({ status: name === 'Pause' ? 'playing' : 'paused', currentTrack: track() }),
  );
  const look = button(name).innerHTML;
  cleanup();
  return look;
}

function dragCover(dx: number) {
  const cover = screen.getByTestId('player-cover');
  fireEvent.pointerDown(cover, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
  fireEvent.pointerMove(cover, { pointerId: 1, clientX: 200 + dx, clientY: 200 });
}

function swipeCover(dx: number) {
  dragCover(dx);
  fireEvent.pointerUp(screen.getByTestId('player-cover'), {
    pointerId: 1,
    clientX: 200 + dx,
    clientY: 200,
  });
  // Past the slide that ends in the step.
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

function openOptions(noun: SourceNoun) {
  // The phone header and the desk header each carry the trigger.
  fireEvent.click(screen.getAllByRole('button', { name: `${noun} and Track options` })[0]!);
  return within(screen.getByRole('dialog'));
}

describe.each(SURFACES)('the $name surface', (surface) => {
  it.each(TRANSPORT_PRESSES)(
    'fires only player.$action from $control',
    ({ control, status, action }) => {
      const player = stubPlayer({ status, currentTrack: track() });
      surface.show(player);

      press(control);

      expect(fired(player)).toEqual({ [action]: 1 });
    },
  );

  it('names the playback mode for its source and cycles it', () => {
    const player = playingPlayer({ playbackMode: 'shuffle' });
    surface.show(player);

    press(`Playback mode: Shuffle ${surface.noun} — switch to Loop ${surface.noun}`);

    expect(fired(player)).toEqual({ cyclePlaybackMode: 1 });
  });

  it('opens the queue from the queue control, even with no Track audible yet', () => {
    const player = stubPlayer({ status: 'waiting' });
    surface.show(player);
    expect(screen.queryByRole('dialog')).toBeNull();

    press(`Tracks in this ${surface.noun}`);

    expect(screen.getByRole('dialog', { name: surface.queueSheet })).toBeTruthy();
    expect(fired(player)).toEqual({});
  });

  it.each(TRANSPORT_STATES)(
    'shows $toggle for a $status player when play intent is $playIntentPending',
    ({ status, playIntentPending, toggle, waits }) => {
      const resting = restingToggle(surface, toggle);
      surface.show(
        stubPlayer({
          status,
          playIntentPending,
          currentTrack: status === 'waiting' ? null : track(),
        }),
      );

      const toggleButton = button(toggle);
      expect(toggleButton.innerHTML !== resting).toBe(waits);
      for (const control of [toggleButton, button(BACK), button(SKIP)]) {
        expect(control).toHaveProperty('disabled', false);
      }
      expect(screen.getByText(surface.statusLine[status])).toBeTruthy();
    },
  );

  describe('swiping the cover', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('skips on a swipe left', () => {
      const player = playingPlayer();
      surface.show(player);

      swipeCover(-120);

      expect(fired(player)).toEqual({ skip: 1 });
    });

    it('steps to the previous Track on a swipe right, which is not Back', () => {
      const player = playingPlayer();
      surface.show(player);

      swipeCover(120);

      expect(fired(player)).toEqual({ previous: 1 });
    });

    it('reveals the art its source shows for the neighboring Tracks', () => {
      surface.show(playingPlayer());

      dragCover(-40);

      const art = screen
        .getAllByTestId('cover-peek')
        .map((peek) => peek.querySelector('img')?.getAttribute('src'));
      expect(art).toEqual(surface.swipeArt);
    });
  });

  it('offers no Lyrics on a Track without words', () => {
    surface.show(playingPlayer());

    expect(screen.queryByRole('button', { name: 'Lyrics' })).toBeNull();
  });

  it('turns the cover to the Lyrics, where a line seeks and expanding opens the sheet', async () => {
    const player = playingPlayer({ currentTrack: track(VOCAL_TRACK) });
    surface.show(player);

    press('Lyrics');
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(SEEK_LINE.text) }));

    expect(fired(player)).toEqual({ seekTo: 1 });
    expect(player.seekTo).toHaveBeenCalledWith(SEEK_LINE.timeSeconds);

    press('Open full lyrics');

    expect(screen.getByRole('dialog', { name: 'Lyrics' })).toBeTruthy();
  });
});

describe('the New music status on a Session', () => {
  const status = () => screen.getByTestId('player-new-music');

  it('counts live generation towards the target, from the same numbers as the slider', () => {
    SESSION_SURFACE.show(
      playingPlayer({
        generatingTracksAhead: 2,
        generatedDurationSeconds: 22 * 60,
        unknownDurationTrackCount: 0,
      }),
    );

    expect(status().textContent).toContain('Generating 2');
    expect(status().textContent).toContain('22 / 60 min');
    expect(screen.getByTestId('new-music-ring')).toBeTruthy();
    expect(screen.getByTestId('progress-track-number').textContent).toContain('Generating 2');
  });

  it('shows no ring while nothing is being generated', () => {
    SESSION_SURFACE.show(playingPlayer({ generatedDurationSeconds: 12 * 60 }));

    expect(status().textContent).toContain('12 / 60 min');
    expect(screen.queryByTestId('new-music-ring')).toBeNull();
  });

  it('drops the ring while the worker is silent on Tracks in flight', () => {
    SESSION_SURFACE.show(
      playingPlayer({ generatingTracksAhead: 2, generationStatus: 'worker_stalled' }),
    );

    expect(status().getAttribute('aria-label')).toBe('New music: New music paused. Change.');
    expect(screen.queryByTestId('new-music-ring')).toBeNull();
  });

  it('opens the New music sheet from the header', () => {
    SESSION_SURFACE.show(playingPlayer());

    fireEvent.click(status());

    expect(screen.getByRole('dialog', { name: 'New music' })).toBeTruthy();
  });

  it('opens the same sheet from the options menu, one sheet at a time', () => {
    SESSION_SURFACE.show(playingPlayer());

    const sheet = openOptions('Session');
    fireEvent.click(sheet.getByTestId('player-new-music-row'));

    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'New music' })).toBeTruthy();
  });
});

describe('the Session shell belongs to a Session alone', () => {
  /** A player with every shell piece lit, whichever surface it is handed to. */
  const busySessionPlayer = () =>
    playingPlayer({
      generationStatus: 'provider_error',
      generatingTracksAhead: 2,
      sourceKind: 'stream',
      switchPending: true,
      queueLength: 2,
      trackCount: 2,
      currentTrackNumber: 1,
      playableQueueItemIds: ['track-1', 'track-2'],
    });

  const SHELL: Record<string, () => HTMLElement[]> = {
    'generation banner': () => screen.queryAllByText(/playing your ready tracks/),
    'source badge': () => screen.queryAllByText(/Live stream/),
    'vibe switch chip': () => screen.queryAllByText(/Switching to the new vibe/),
    'slider Session status': () => screen.queryAllByText('Generating 2'),
    Reroll: () => screen.queryAllByRole('button', { name: /^Reroll Track/ }),
    'Change Vibe': () => screen.queryAllByRole('button', { name: 'Change Vibe' }),
    'More Like This': () => screen.queryAllByRole('button', { name: 'More Like This' }),
    'New music': () => screen.queryAllByRole('button', { name: /^New music:/ }),
  };

  const shellOnScreen = () => Object.keys(SHELL).filter((piece) => SHELL[piece]!().length > 0);

  const SHELL_OPTIONS = [
    'New music',
    'Reroll Track',
    'Change Vibe',
    'Rename Session',
    'Convert to Playlist',
    'Download Session',
    'Delete Session',
    'Stop Session',
  ];

  function shellOptionsOnScreen(noun: SourceNoun) {
    const sheet = openOptions(noun);
    return SHELL_OPTIONS.filter((row) => sheet.queryByText(row) !== null);
  }

  /** The first Track still generating: nothing playable, a Play armed. */
  const coldStartPlayer = () => stubPlayer({ status: 'waiting', playIntentPending: true });

  it('shows on the Session surface', () => {
    SESSION_SURFACE.show(busySessionPlayer());

    expect(shellOnScreen()).toEqual(Object.keys(SHELL));
    expect(shellOptionsOnScreen('Session')).toEqual(SHELL_OPTIONS);
  });

  it('narrates a cold start on the Session surface', () => {
    SESSION_SURFACE.show(coldStartPlayer());

    expect(screen.getByRole('progressbar', { name: 'Preparing your session' })).toBeTruthy();
  });

  describe.each([PLAYLIST_SURFACE, OFFLINE_SURFACE])('on the $name surface', (surface) => {
    it('stays away, whatever the player reports', () => {
      surface.show(busySessionPlayer());

      expect(shellOnScreen()).toEqual([]);
      expect(shellOptionsOnScreen(surface.noun)).toEqual([]);
    });

    it('narrates no cold start', () => {
      surface.show(coldStartPlayer());

      expect(screen.queryByRole('progressbar')).toBeNull();
    });
  });
});

describe('the Offline surface holds nothing that writes to the server', () => {
  /** Every control in reach, by name; a disabled one counts, because the surface
   *  leaves out what it cannot do rather than greying it. */
  function controls(scope: Pick<typeof screen, 'queryAllByRole'>) {
    const elements = (['button', 'link', 'switch'] as const).flatMap((role) =>
      scope.queryAllByRole(role),
    );
    const names = elements.map((el) => el.getAttribute('aria-label') ?? el.textContent);
    return [...new Set(names)].sort();
  }

  describe.each(['Playlist', 'Session'] as const)('for a %s kept offline', (noun) => {
    it('offers only the transport, the way back, Lyrics and the options', () => {
      showOffline(playingPlayer({ currentTrack: track(VOCAL_TRACK) }), noun);

      expect(controls(screen)).toEqual(
        [
          'Offline Library',
          `${noun} and Track options`,
          `Tracks in this ${noun}`,
          BACK,
          'Pause',
          SKIP,
          `Playback mode: Loop ${noun} — switch to Loop Track`,
          'Lyrics',
        ].sort(),
      );
    });

    it('offers only what plays from the device in its options', () => {
      showOffline(playingPlayer({ currentTrack: track(VOCAL_TRACK) }), noun);

      const sheet = openOptions(noun);

      // A row's text carries its description too, so it is matched by how it starts.
      const offered = controls(sheet);
      const expected = [`Close ${noun} and Track options`, 'Lyrics', 'Track Data', 'Sleep Timer'];
      expect(offered).toHaveLength(expected.length);
      for (const label of expected) {
        expect(offered.some((name) => name?.startsWith(label))).toBe(true);
      }
      expect(sheet.getByText(`This ${noun}`)).toBeTruthy();
    });
  });

  it('leaves for the list from the way back, which is not the transport’s Back', () => {
    const player = playingPlayer();
    const onBack = vi.fn();
    showOffline(player, 'Playlist', onBack);

    press('Offline Library');

    expect(onBack).toHaveBeenCalledOnce();
    expect(fired(player)).toEqual({});
  });
});
