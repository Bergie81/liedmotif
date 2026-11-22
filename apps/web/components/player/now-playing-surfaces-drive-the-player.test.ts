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
import type { IncomingSource, SourceNoun } from './player-presentation';
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
vi.mock('./session-cover-sheet', () => ({ SessionCoverSheet: () => null }));
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
  // Reduced motion, so titles settle instead of scrambling.
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
  soleMemberDeletedTrackCount: 0,
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
    applyRetentionAdded: vi.fn(),
    toggleFavorite: vi.fn(),
    cyclePlaybackMode: vi.fn(),
    setPlaybackMode: vi.fn(),
    playQueueItem: vi.fn(),
    applyTrackTitle: vi.fn(),
    toggleBlend: vi.fn(),
    adoptStoredPlaybackSettings: vi.fn(),
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
  llmConfigured: false,
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

const NO_VIBE_CHANGE: PlayerContextValue['vibeChange'] = {
  pendingSessionId: null,
  restyling: false,
  error: null,
};

function mount(
  player: PlaybackControllerApi,
  source: EngagedSource,
  surface: (playback: LivePlayback) => ReactElement,
  vibeChange: PlayerContextValue['vibeChange'] = NO_VIBE_CHANGE,
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
    vibeChange,
    sleepTimer: { endsAt: null, start: vi.fn(), cancel: vi.fn() },
    startCount: 0,
  };
  provider.context = context;
  render(surface(playback), { wrapper: AppShell });
}

function showOffline(
  player: PlaybackControllerApi,
  noun: SourceNoun,
  onBack: () => void = noop,
  { tracks = [], expired = () => false }: Partial<Extract<EngagedSource, { kind: 'offline' }>> = {},
) {
  mount(
    player,
    {
      kind: 'offline',
      key: 'playlist:offline',
      name: OFFLINE_NAME,
      tracks,
      startTrackId: null,
      expired,
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
    waiting: 'Preparing Your Session',
    loading: 'Connecting',
    playing: 'Now Playing',
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

const PLAYLIST_SOURCE: EngagedSource = {
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
};

const PLAYLIST_SURFACE: Surface = {
  name: 'Playlist',
  noun: 'Playlist',
  statusLine: {
    waiting: 'Preparing · Playlist',
    loading: 'Connecting · Playlist',
    playing: 'Now Playing · Playlist',
    paused: 'Paused · Playlist',
  },
  queueSheet: 'Focus Nights',
  swipeArt: ['/api/covers/previous-cover', '/api/covers/next-cover'],
  show: (player) =>
    mount(player, PLAYLIST_SOURCE, (playback) =>
      h(PlaylistNowPlaying, { playback, playlist: PLAYLIST }),
    ),
};

const OFFLINE_SURFACE: Surface = {
  name: 'Offline',
  noun: 'Playlist',
  statusLine: {
    waiting: 'Preparing · Offline',
    loading: 'Connecting · Offline',
    playing: 'Now Playing · Offline',
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

/** What a screen reader hears when the direction changes. */
function announcedChange(): string | null {
  return screen.getByTestId('player-status-change').textContent;
}

/** The line above the title, and whether the pulsing dot marks work in progress. */
function statusLine(): { text: string | null; underWay: boolean } {
  const line = screen.getByTestId('player-status-line');
  return {
    text: line.textContent,
    underWay: within(line).queryByTestId('player-status-dot') !== null,
  };
}

/** Everything written over the cover art; these Tracks have no words, so no
 *  Lyrics tab either. */
function coverText(): string | null {
  return screen.getByTestId('player-cover').textContent;
}

const BACK = 'Back — restart or previous track';
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
  fireEvent.click(screen.getAllByRole('button', { name: `${noun} and Track Options` })[0]!);
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

    press(`Tracks in This ${surface.noun}`);

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

    press('Open Full Lyrics');

    expect(screen.getByRole('dialog', { name: 'Lyrics' })).toBeTruthy();
  });
});

describe('the New Music status on a Session', () => {
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

    expect(status().getAttribute('aria-label')).toBe('New Music: New Music Paused. Change.');
    expect(screen.queryByTestId('new-music-ring')).toBeNull();
  });

  it('opens the New Music sheet from the header', () => {
    SESSION_SURFACE.show(playingPlayer());

    fireEvent.click(status());

    expect(screen.getByRole('dialog', { name: 'New Music' })).toBeTruthy();
  });

  it('opens the same sheet from the options menu, one sheet at a time', () => {
    SESSION_SURFACE.show(playingPlayer());

    const sheet = openOptions('Session');
    fireEvent.click(sheet.getByTestId('player-new-music-row'));

    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'New Music' })).toBeTruthy();
  });
});

describe('the Session shell belongs to a Session alone', () => {
  /** A player with every shell piece lit, whichever surface it is handed to. */
  const busySessionPlayer = () =>
    playingPlayer({
      generationStatus: 'provider_error',
      generatingTracksAhead: 2,
      switchPending: true,
      queueLength: 2,
      trackCount: 2,
      currentTrackNumber: 1,
      playableQueueItemIds: ['track-1', 'track-2'],
    });

  const SHELL: Record<string, () => HTMLElement[]> = {
    'generation banner': () => screen.queryAllByText(/playing your ready tracks/),
    'vibe switch status': () => screen.queryAllByText(/Switching to the new vibe/),
    'slider Session status': () => screen.queryAllByText('Generating 2'),
    Reroll: () => screen.queryAllByRole('button', { name: /^Reroll Track/ }),
    'Change Vibe': () => screen.queryAllByRole('button', { name: 'Change Vibe' }),
    'More Like This': () => screen.queryAllByRole('button', { name: 'More Like This' }),
    'New Music': () => screen.queryAllByRole('button', { name: /^New Music:/ }),
  };

  const shellOnScreen = () => Object.keys(SHELL).filter((piece) => SHELL[piece]!().length > 0);

  const SHELL_OPTIONS = [
    'New Music',
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

describe('a Session prepared behind a Playlist', () => {
  function showPlaylistWith(incoming: IncomingSource) {
    mount(
      playingPlayer({ trackCount: 1, playableQueueItemIds: ['track-1'] }),
      PLAYLIST_SOURCE,
      (playback) => h(PlaylistNowPlaying, { playback, playlist: PLAYLIST, incoming }),
    );
  }

  const NIGHT_DRIVE: IncomingSource = { noun: 'Session', title: 'Night Drive' };

  it('names it on the status line, in place of the player status', () => {
    showPlaylistWith(NIGHT_DRIVE);

    expect(statusLine()).toEqual({ text: 'Preparing “Night Drive”…', underWay: true });
  });

  it('announces it to screen readers on its own, beside what plays', () => {
    showPlaylistWith(NIGHT_DRIVE);

    expect(announcedChange()).toBe('Preparing “Night Drive”…');
    expect(screen.getByText('Now Playing: Night Drive from Late Rain.')).toBeTruthy();
  });

  it('writes nothing over the cover and no Session status on the progress bar', () => {
    showPlaylistWith(NIGHT_DRIVE);

    expect(coverText()).toBe('');
    expect(screen.getByTestId('progress-track-number').textContent).toBe('Track 1/1');
  });
});

describe('the status line of a Session', () => {
  function showSession(
    player: PlaybackControllerApi,
    incoming: IncomingSource | null = null,
    vibeChange = NO_VIBE_CHANGE,
  ) {
    mount(
      player,
      { kind: 'session', session: SESSION },
      (playback) =>
        h(NowPlaying, {
          playback,
          session: SESSION,
          incoming,
          onSessionChange: noop,
          onStopped: noop,
        }),
      vibeChange,
    );
  }

  it('reads the player status while nothing changes direction', () => {
    showSession(playingPlayer());

    expect(statusLine()).toEqual({ text: 'Now Playing', underWay: false });
    expect(announcedChange()).toBe('');
  });

  it('names the next Session while this one keeps playing', () => {
    showSession(playingPlayer(), { noun: 'Session', title: null });

    expect(statusLine()).toEqual({ text: 'Preparing your next session…', underWay: true });
  });

  describe('while a request from the Change Vibe sheet is in flight', () => {
    const paused = () => stubPlayer({ status: 'paused', currentTrack: track() });
    const inFlight = { ...NO_VIBE_CHANGE, pendingSessionId: SESSION.id };

    it('says the vibe is changing when it asks for a new vibe', () => {
      showSession(paused(), null, { ...inFlight, restyling: true });

      expect(statusLine()).toEqual({ text: 'Changing vibe…', underWay: true });
    });

    it('keeps the player status when it only saves the duration', () => {
      showSession(paused(), null, inFlight);

      expect(statusLine()).toEqual({ text: 'Paused', underWay: false });
    });
  });

  it('says an armed switch-now Change Vibe is switching', () => {
    showSession(playingPlayer({ switchPending: true }));

    expect(statusLine()).toEqual({ text: 'Switching to the new vibe…', underWay: true });
  });

  it('says the new vibe is queued while the old one plays out', () => {
    const ready = { final: '/api/tracks/ready/audio', stream: null };
    // The Session moved to revision 2 and a Track of it waits behind the
    // audible revision-1 Track.
    showSession(
      playingPlayer({
        styleRevision: 2,
        queueItems: [
          { id: 'track-1', position: 0, state: 'playing', styleRevision: 1, assets: ready },
          { id: 'track-2', position: 1, state: 'queued', styleRevision: 2, assets: ready },
        ] as PlaybackControllerApi['queueItems'],
      }),
    );

    expect(statusLine()).toEqual({ text: 'New vibe queued', underWay: true });
  });

  it('leaves the slider to the Session’s own work', () => {
    showSession(playingPlayer({ generatingTracksAhead: 2, trackCount: 1, currentTrackNumber: 1 }), {
      noun: 'Session',
      title: 'Night Drive',
    });

    expect(screen.getByTestId('progress-track-number').textContent).toBe(
      'Track 1/1 · Generating 2',
    );
  });

  it.each(['stream', 'final'] as const)(
    'writes nothing over the cover while the direction changes and a %s source plays',
    (sourceKind) => {
      showSession(playingPlayer({ sourceKind, switchPending: true }), {
        noun: 'Session',
        title: 'Night Drive',
      });

      expect(coverText()).toBe('');
    },
  );

  it('writes nothing over the cover during a cold start', () => {
    // The first Track is still generating.
    showSession(stubPlayer({ status: 'waiting', playIntentPending: true }));

    expect(coverText()).toBe('');
  });

  it('announces the change to screen readers on its own, beside what plays', () => {
    showSession(playingPlayer({ switchPending: true }));

    expect(announcedChange()).toBe('Switching to the new vibe…');
    expect(screen.getByText('Now Playing: Night Drive by Liedmotif.')).toBeTruthy();
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
          `${noun} and Track Options`,
          `Tracks in This ${noun}`,
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
      const expected = [`Close ${noun} and Track Options`, 'Lyrics', 'Track Data', 'Sleep Timer'];
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

describe('the Offline surface past a Lounge copy’s week', () => {
  const OWN = track({ queueItemId: 'own', trackId: 'own', title: 'Own Track' });
  const LOUNGE = track({ queueItemId: 'lounge', trackId: 'lounge', title: 'Lounge Track' });
  const EXPIRED_LINE = 'The rest of this playlist expired on this device. Connect to refresh it.';
  const loungeExpired = (trackId: string) => trackId === 'lounge';

  it('marks an expired Track in its list, and the row cannot start it', () => {
    const player = playingPlayer({ currentTrack: OWN });
    showOffline(player, 'Playlist', noop, { tracks: [LOUNGE, OWN], expired: loungeExpired });

    press('Tracks in This Playlist');
    const sheet = within(screen.getByTestId('playlist-queue'));

    expect(sheet.getByText('Lounge Track').closest('li')?.textContent).toContain('Expired');
    expect(sheet.queryByRole('button', { name: 'Play Lounge Track' })).toBeNull();
    expect(sheet.getByRole('button', { name: 'Restart Own Track' })).toBeTruthy();
  });

  it('says why once only expired Tracks are left', () => {
    showOffline(stubPlayer({ status: 'ended' }), 'Playlist', noop, {
      tracks: [LOUNGE],
      expired: loungeExpired,
    });

    expect(screen.getByRole('alert').textContent).toBe(EXPIRED_LINE);
  });

  it('says nothing while a Track that may still play is left', () => {
    showOffline(playingPlayer({ currentTrack: LOUNGE }), 'Playlist', noop, {
      tracks: [LOUNGE, OWN],
      expired: loungeExpired,
    });

    expect(screen.queryByText(EXPIRED_LINE)).toBeNull();
  });
});
