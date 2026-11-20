// @vitest-environment jsdom
import { createElement, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { QueueItem } from '@liedmotif/shared';
import { SessionTracksDialog, SessionTracksProvider } from './session-tracks-sheet';
import { TransportControls } from '@/components/player/transport-controls';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SessionCard } from './session-card';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));

function StoppedSessionCard({
  session,
}: {
  session: {
    id: string;
    title: string | null;
    genreTags: string[];
    coverImageId: string | null;
  };
}) {
  return createElement(SessionCard, {
    sessionId: session.id,
    title: session.title,
    coverImageId: session.coverImageId,
    genreTags: session.genreTags,
    trackCount: 2,
  });
}

const player = vi.hoisted(() => ({
  toggle: vi.fn(),
  playQueueItem: vi.fn(),
  refreshQueue: vi.fn(),
}));
const context = vi.hoisted(() => ({
  playback: {
    session: { id: 'session-1' },
    player: {
      currentTrack: {
        trackId: '00000000-0000-4000-8000-000000000001',
        queueItemId: 'current-slot',
      },
      status: 'playing',
      queueItems: [] as QueueItem[],
      playableQueueItemIds: [] as string[],
      generatingTracksAhead: 0,
    },
  },
  engage: vi.fn(),
  beginOtherMusic: async () => true,
}));
vi.mock('@/components/player/player-provider', () => ({
  usePlayerContext: () => ({
    ...context,
    engagedSource: { kind: 'session', session: context.playback.session },
    pending: null,
    playback: { ...context.playback, player: { ...context.playback.player, ...player } },
  }),
}));
beforeEach(() => {
  context.playback.session.id = 'session-1';
  context.playback.player.queueItems = [];
  context.playback.player.playableQueueItemIds = [];
  context.playback.player.generatingTracksAhead = 0;
});
vi.mock('@/components/player/autoplay-arm', () => ({ primePlayerAutoplay: vi.fn() }));

function queueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'waiting-slot',
    position: 1,
    state: 'queued',
    trackId: null,
    track: null,
    vibeSwitchSetAside: false,
    styleRevision: 1,
    targetBpm: null,
    targetKey: null,
    durationSeconds: null,
    assets: { final: null, stream: null },
    blendAnalysis: null,
    ...overrides,
  };
}
vi.mock('@/lib/use-client-id', () => ({ useClientId: () => 'client-1' }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each(['cover', 'title', 'genres', 'summary'])(
  'opens the current Session player from the header %s without changing playback',
  async (target) => {
    const fetcher = vi.fn(async () => ({
      json: async () => ({
        ok: true,
        data: {
          items: [],
          total: 0,
          totalDurationSeconds: 0,
          genreTags: ['ambient'],
          nextCursor: null,
        },
      }),
    }));
    vi.stubGlobal('fetch', fetcher);
    const close = vi.fn();
    render(
      createElement(SessionTracksDialog, {
        open: true,
        onOpenChange: close,
        session: {
          id: 'session-1',
          title: 'Focus',
          genreTags: [],
          coverImageId: '00000000-0000-4000-8000-000000000005',
        },
      }),
    );
    await screen.findByText('Ambient');
    const header = screen.getByRole('button', { name: 'Open Focus in Player' });
    const node =
      target === 'cover'
        ? header.querySelector('img')!
        : screen.getByText(
            target === 'title' ? 'Focus' : target === 'genres' ? 'Ambient' : '0:00 · No tracks yet',
          );
    fireEvent.click(node);
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/player'));
    expect(close).toHaveBeenCalledWith(false);
    expect(context.engage).not.toHaveBeenCalled();
    expect(player.toggle).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

const MORNING = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Morning',
  durationSeconds: 125,
  styleRevision: 1,
};
const OLDER = { ...MORNING, id: '00000000-0000-4000-8000-000000000002', title: 'Older' };

function tracksPage(data: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      items: [],
      total: 0,
      genreTags: ['ambient'],
      totalDurationSeconds: 0,
      nextCursor: null,
      ...data,
    },
  };
}

function stubFetch(body: unknown) {
  const fetcher = vi.fn(async () => ({ json: async () => body }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

const TARGET_SESSION = {
  id: '00000000-0000-4000-8000-000000000003',
  status: 'active',
  title: 'Focus',
  generationStatus: 'ok',
  generationStatusScope: null,
  sessionMode: 'repeat',
  coverImageId: null,
  statusMessageSafe: null,
  createdAt: '2026-09-13T00:00:00.000Z',
  updatedAt: '2026-09-13T00:00:00.000Z',
};

it('resumes a stopped Session before navigating and prevents duplicate header requests', async () => {
  const session = TARGET_SESSION;
  let finishResume!: () => void;
  const fetcher = vi.fn((url: string) => {
    if (url.includes('/resume'))
      return new Promise((resolve) => {
        finishResume = () =>
          resolve({
            json: async () => ({ ok: true, data: { session, supersededSessionId: null } }),
          });
      });
    return Promise.resolve({
      json: async () =>
        url.includes('/tracks')
          ? tracksPage()
          : { ok: true, data: { items: [], nextCursor: null, activeSession: null, pinned: [] } },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const close = vi.fn();
  const props = { open: true, onOpenChange: close, session: { ...session, genreTags: [] } };
  const view = render(createElement(SessionTracksDialog, props));
  fireEvent.click(screen.getByRole('button', { name: 'Open Focus in Player' }));
  await waitFor(() => expect(finishResume).toBeTypeOf('function'));
  expect(navigation.push).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open Focus in Player' }));
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/resume'))).toHaveLength(1);
  view.rerender(createElement(SessionTracksDialog, { ...props, open: false }));
  await act(async () => finishResume());
  expect(context.engage).toHaveBeenCalledWith(session, { autoplay: true });
  expect(navigation.push).toHaveBeenCalledWith('/player');
  expect(close).toHaveBeenCalledWith(false);
});

it.each(['source change', 'page unmount'])(
  'ignores a late header Resume after %s',
  async (interruption) => {
    let finishResume!: () => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('/resume'))
          return new Promise((resolve) => {
            finishResume = () =>
              resolve({
                json: async () => ({
                  ok: true,
                  data: { session: TARGET_SESSION, supersededSessionId: null },
                }),
              });
          });
        return Promise.resolve({
          json: async () =>
            url.includes('/tracks')
              ? tracksPage()
              : {
                  ok: true,
                  data: { items: [], nextCursor: null, activeSession: null, pinned: [] },
                },
        });
      }),
    );
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      session: { ...TARGET_SESSION, genreTags: [] },
    };
    const view = render(createElement(SessionTracksDialog, props));
    fireEvent.click(screen.getByRole('button', { name: 'Open Focus in Player' }));
    await waitFor(() => expect(finishResume).toBeTypeOf('function'));
    if (interruption === 'page unmount') view.unmount();
    else {
      context.playback.session.id = 'newer-session';
      view.rerender(createElement(SessionTracksDialog, props));
    }
    await act(async () => finishResume());
    expect(navigation.push).not.toHaveBeenCalled();
    expect(context.engage).not.toHaveBeenCalled();
  },
);

it('opens an active Session from another playback source without attempting Resume', async () => {
  const active = { ...TARGET_SESSION, trackCount: 0, totalDurationSeconds: 0, genreTags: [] };
  const fetcher = vi.fn(async (url: string) => ({
    json: async () =>
      url.includes('/tracks')
        ? tracksPage()
        : { ok: true, data: { items: [], nextCursor: null, activeSession: active, pinned: [] } },
  }));
  vi.stubGlobal('fetch', fetcher);
  render(
    createElement(SessionTracksDialog, {
      open: true,
      onOpenChange: vi.fn(),
      session: active,
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open Focus in Player' }));
  await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/player'));
  expect(context.engage).toHaveBeenCalledWith(active, { autoplay: true });
  expect(fetcher.mock.calls.some(([url]) => url.includes('/resume'))).toBe(false);
});

it('keeps the panel and playback on a failed Resume, and retries opening that Session', async () => {
  let fail = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      json: async () => {
        if (url.includes('/tracks')) return tracksPage();
        if (url.includes('/resume'))
          return fail
            ? {
                ok: false,
                error: { code: 'conflict', message: 'Session could not resume.', retryable: false },
              }
            : { ok: true, data: { session: TARGET_SESSION, supersededSessionId: null } };
        return { ok: true, data: { items: [], nextCursor: null, activeSession: null, pinned: [] } };
      },
    })),
  );
  const close = vi.fn();
  render(
    createElement(SessionTracksDialog, {
      open: true,
      onOpenChange: close,
      session: { ...TARGET_SESSION, genreTags: [] },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open Focus in Player' }));
  await screen.findByText('Session could not resume.');
  expect(close).not.toHaveBeenCalled();
  expect(context.engage).not.toHaveBeenCalled();
  expect(navigation.push).not.toHaveBeenCalled();
  expect(player.toggle).not.toHaveBeenCalled();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/player'));
  expect(context.engage).toHaveBeenCalledWith(TARGET_SESSION, { autoplay: true });
});

it('clears a header failure when the listener chooses a Track instead', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      json: async () => {
        if (url.includes('/tracks')) return tracksPage({ items: [MORNING], total: 1 });
        return {
          ok: false,
          error: { code: 'internal_error', message: 'Could not open Session.', retryable: true },
        };
      },
    })),
  );
  render(
    createElement(SessionTracksDialog, {
      open: true,
      onOpenChange: vi.fn(),
      session: { ...TARGET_SESSION, genreTags: [] },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open Focus in Player' }));
  await screen.findByText('Could not open Session.');
  fireEvent.click(screen.getByRole('button', { name: 'Pause Morning' }));
  expect(player.toggle).toHaveBeenCalledOnce();
  expect(screen.queryByText('Could not open Session.')).toBeNull();
  expect(navigation.push).not.toHaveBeenCalled();
});

it('opens the complete Session list from the player transport without changing playback', async () => {
  const fetcher = stubFetch(
    tracksPage({
      items: [{ ...OLDER, title: 'Older vibe', durationSeconds: 180 }, MORNING],
      total: 35,
      totalDurationSeconds: 4200,
      nextCursor: 'next-page',
    }),
  );
  function Player() {
    const [open, setOpen] = useState(false);
    return createElement(
      TooltipProvider,
      null,
      createElement(TransportControls, {
        player: {
          status: 'playing',
          playIntentPending: false,
          playbackMode: 'shuffle',
          cyclePlaybackMode: vi.fn(),
          back: vi.fn(),
          toggle: vi.fn(),
          skip: vi.fn(),
        },
        sourceNoun: 'Session',
        onOpenQueue: () => setOpen(true),
      }),
      createElement(SessionTracksDialog, {
        open,
        onOpenChange: setOpen,
        session: { id: 'session-1', title: 'Focus', coverImageId: null, genreTags: ['jazz'] },
      }),
    );
  }
  render(createElement(Player));
  expect(fetcher).not.toHaveBeenCalled();
  const opener = screen.getByRole('button', { name: 'Tracks in This Session' });
  opener.focus();
  fireEvent.click(opener);
  await screen.findByText('Older vibe');
  expect(screen.getByText('Ambient').nextElementSibling?.textContent).toBe('1:10:00 · 35 tracks');
  expect(screen.getByRole('list', { name: 'Session tracks' }).textContent).toBe(
    'Older vibe3:00Morning2:05',
  );
  expect(screen.getByRole('button', { name: 'Pause Morning' }).getAttribute('aria-current')).toBe(
    'true',
  );
  expect(player.toggle).not.toHaveBeenCalled();
  expect(context.engage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Pause Morning' }));
  expect(player.toggle).toHaveBeenCalledOnce();
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close Session Tracks' }));
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

it('shows live generation progress separately from playable Tracks, only for its Session', async () => {
  stubFetch(tracksPage());
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    session: { id: 'session-1', title: 'Focus', coverImageId: null, genreTags: [] },
  };
  context.playback.player.generatingTracksAhead = 2;
  const view = render(createElement(SessionTracksDialog, props));
  await screen.findByText('No playable tracks yet.');
  expect(screen.getByRole('status').textContent).toBe('Preparing 2 tracks…');
  expect(screen.getByRole('list', { name: 'Session tracks' }).children).toHaveLength(0);
  context.playback.player.generatingTracksAhead = 1;
  view.rerender(createElement(SessionTracksDialog, props));
  expect(screen.getByRole('status').textContent).toBe('Preparing 1 track…');
  context.playback.player.generatingTracksAhead = 0;
  view.rerender(createElement(SessionTracksDialog, props));
  expect(screen.queryByRole('status')).toBeNull();
  context.playback.player.queueItems = [queueItem()];
  view.rerender(createElement(SessionTracksDialog, props));
  expect(screen.getByRole('status').textContent).toBe('Preparing 1 track…');
  context.playback.player.queueItems = [];
  context.playback.player.generatingTracksAhead = 2;
  view.rerender(
    createElement(SessionTracksDialog, {
      ...props,
      session: { ...props.session, id: 'session-2' },
    }),
  );
  await screen.findByText('No playable tracks yet.');
  expect(screen.queryByRole('status')).toBeNull();
});

it('preserves a divider for every changed vibe across pages and reopening without repeating late siblings', async () => {
  const tracks = [null, 1, 2, 2, 1, 3, 2].map((styleRevision, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index + 1}`,
    title: `Track ${index + 1}`,
    durationSeconds: 125,
    styleRevision,
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const more = new URL(url, 'http://localhost').searchParams.has('cursor');
      return {
        json: async () =>
          tracksPage({
            items: more ? tracks.slice(3) : tracks.slice(0, 3),
            total: 7,
            genreTags: [],
            nextCursor: more ? null : 'next-page',
          }),
      };
    }),
  );
  render(
    createElement(
      SessionTracksProvider,
      null,
      createElement(StoppedSessionCard, {
        session: { id: 'session-1', title: 'Focus', genreTags: [], coverImageId: null },
      }),
    ),
  );
  for (let opening = 0; opening < 2; opening++) {
    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    await screen.findByText('Track 3');
    expect(screen.getAllByText('New Vibe from Here')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Load More' }));
    await screen.findByText('Track 7');
    const dividers = screen.getAllByText('New Vibe from Here');
    expect(dividers).toHaveLength(2);
    expect(dividers[0]!.closest('li')!.textContent).toContain('Track 3');
    expect(dividers[1]!.closest('li')!.textContent).toContain('Track 6');
    expect(
      screen.getByRole('list', { name: 'Session tracks' }).querySelectorAll('button'),
    ).toHaveLength(7);
    fireEvent.click(screen.getByRole('button', { name: 'Close Session Tracks' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  }
});

it('keeps the card rail action apart from the Tracks list', () => {
  const onOptions = vi.fn();
  const fetcher = stubFetch(tracksPage());
  render(
    createElement(
      SessionTracksProvider,
      null,
      createElement(SessionCard, {
        sessionId: 'session-1',
        title: 'Focus',
        coverImageId: null,
        trackCount: 2,
        action: createElement('button', { type: 'button', onClick: onOptions }, 'Options'),
      }),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Options' }));
  expect(onOptions).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([0, 1, 2])(
  'a stopped card always opens its Tracks list (%i Tracks)',
  async (trackCount) => {
    const fetcher = stubFetch(tracksPage());
    render(
      createElement(
        SessionTracksProvider,
        null,
        createElement(SessionCard, {
          sessionId: 'session-1',
          title: 'Focus',
          coverImageId: null,
          trackCount,
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    await screen.findByRole('dialog');
    const urls = (fetcher.mock.calls as unknown as [string][]).map(([url]) => url);
    expect(urls.some((url) => url.includes('/resume'))).toBe(false);
  },
);

it('opens without changing playback, shows Session details and duration, and stays open after toggling', async () => {
  const fetcher = stubFetch(tracksPage({ items: [MORNING], total: 1 }));
  render(
    createElement(
      SessionTracksProvider,
      null,
      createElement(StoppedSessionCard, {
        session: {
          id: 'session-1',
          title: 'Focus',
          genreTags: ['ambient'],
          coverImageId: null,
        },
      }),
    ),
  );
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /^Focus/ }));
  await screen.findByText('Morning');
  const dialog = screen.getByRole('dialog');
  expect(dialog.textContent).toContain('Focus');
  expect(dialog.textContent).toMatch(/ambient/i);
  expect(dialog.textContent).toMatch(/1 Track/i);
  expect(screen.getByText('2:05')).toBeTruthy();
  expect(player.toggle).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Pause Morning' }));
  expect(player.toggle).toHaveBeenCalledOnce();
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close Session Tracks' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('keeps the sheet open when its card moves out of the History list', async () => {
  stubFetch(tracksPage());
  let removeCard = () => {};
  function List() {
    const [visible, setVisible] = useState(true);
    removeCard = () => setVisible(false);
    return createElement(
      SessionTracksProvider,
      null,
      visible
        ? createElement(StoppedSessionCard, {
            session: { id: 'session-1', title: 'Focus', genreTags: [], coverImageId: null },
          })
        : null,
    );
  }
  render(createElement(List));
  fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
  await screen.findByText('No playable tracks yet.');
  await act(async () => removeCard());
  expect(screen.getByRole('dialog')).toBeTruthy();
});

it('finishes an accepted Track selection after its sheet closes', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      json: async () =>
        url.includes('play-track')
          ? {
              ok: true,
              data: {
                supersededSessionId: null,
                session: {
                  id: '00000000-0000-4000-8000-000000000003',
                  status: 'active',
                  title: 'Focus',
                  generationStatus: 'ok',
                  generationStatusScope: null,
                  sessionMode: 'repeat',
                  coverImageId: null,
                  statusMessageSafe: null,
                  createdAt: '2026-09-13T00:00:00.000Z',
                  updatedAt: '2026-09-13T00:00:00.000Z',
                },
              },
            }
          : tracksPage({ items: [OLDER], total: 1 }),
    })),
  );
  const view = () =>
    createElement(
      SessionTracksProvider,
      null,
      createElement(StoppedSessionCard, {
        session: { id: 'session-1', title: 'Focus', genreTags: [], coverImageId: null },
      }),
    );
  const { rerender } = render(view());
  fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Play Older' }));
  await waitFor(() => expect(player.refreshQueue).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: 'Close Session Tracks' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  context.playback.player.queueItems = [
    queueItem({ id: 'old-slot', trackId: OLDER.id, assets: { final: '/audio', stream: null } }),
  ];
  context.playback.player.playableQueueItemIds = ['old-slot'];
  rerender(view());
  expect(player.playQueueItem).toHaveBeenCalledWith('old-slot');
});

it.each([
  ['the engaged Session, from its Queue', 'session-1'],
  ['another Session, through play-track', 'session-2'],
])(
  'closes the sheet and opens the player once a chosen Track plays (%s)',
  async (_branch, sessionId) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        json: async () =>
          url.includes('play-track')
            ? { ok: true, data: { supersededSessionId: null, session: TARGET_SESSION } }
            : tracksPage({ items: [OLDER], total: 2 }),
      })),
    );
    context.playback.player.queueItems = [
      queueItem({ id: 'old-slot', trackId: OLDER.id, assets: { final: '/audio', stream: null } }),
    ];
    context.playback.player.playableQueueItemIds = ['old-slot'];
    render(
      createElement(
        SessionTracksProvider,
        null,
        createElement(StoppedSessionCard, {
          session: { id: sessionId, title: 'Focus', genreTags: [], coverImageId: null },
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Play Older' }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/player'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  },
);

it('keeps a late failure with its Session and retries its Track after reopening', async () => {
  let failSelection!: () => void;
  const fetcher = vi.fn((url: string) => {
    if (url.includes('play-track'))
      return new Promise((resolve) => {
        failSelection = () =>
          resolve({
            json: async () => ({
              ok: false,
              error: { code: 'not_found', message: 'Track unavailable', retryable: false },
            }),
          });
      });
    return Promise.resolve({ json: async () => tracksPage({ items: [OLDER], total: 1 }) });
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    createElement(
      SessionTracksProvider,
      null,
      createElement(StoppedSessionCard, {
        session: { id: 'session-1', title: 'Focus', genreTags: [], coverImageId: null },
      }),
      createElement(StoppedSessionCard, {
        session: { id: 'session-2', title: 'Sleep', genreTags: [], coverImageId: null },
      }),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Play Older' }));
  await waitFor(() => expect(failSelection).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button', { name: 'Close Session Tracks' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Sleep' }));
  await screen.findByText('Older');
  await act(async () => failSelection());
  expect(screen.queryByText(/Track unavailable/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close Session Tracks' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
  await screen.findByText(/Track unavailable/);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  const selections = fetcher.mock.calls.filter(([url]) => url.includes('play-track'));
  expect(selections).toHaveLength(2);
  const lastOptions = (fetcher.mock.calls as unknown as [string, RequestInit][])
    .filter(([url]) => url.includes('play-track'))
    .at(-1)![1];
  expect(JSON.parse(lastOptions.body as string)).toMatchObject({
    sessionId: 'session-1',
    trackId: OLDER.id,
  });
  await act(async () => failSelection());
});

it.each([0, 1, 2])(
  'uses the active card primary action without an extra Tracks button (%i Tracks)',
  async (trackCount) => {
    const onClick = vi.fn();
    stubFetch(tracksPage());
    render(
      createElement(
        SessionTracksProvider,
        null,
        createElement(SessionCard, {
          sessionId: 'session-1',
          title: 'Focus',
          coverImageId: null,
          trackCount,
          active: true,
          onClick,
        }),
      ),
    );
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Tracks in/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    if (trackCount > 1) {
      await screen.findByRole('dialog');
      expect(onClick).not.toHaveBeenCalled();
    } else {
      expect(onClick).toHaveBeenCalledOnce();
      expect(screen.queryByRole('dialog')).toBeNull();
    }
  },
);
