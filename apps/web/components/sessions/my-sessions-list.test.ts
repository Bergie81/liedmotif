// @vitest-environment jsdom
import { createElement, type FunctionComponent } from 'react';
import type { SessionListItem } from '@liedmotif/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEARCH_DEBOUNCE_MS } from '@/components/library/search-debounce';
import { shownToasts, toast } from '@/lib/toast';
import { MySessionsList } from './my-sessions-list';
import type { ResumableSessionsInitialData } from './use-resumable-sessions';

const navigation = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));
vi.mock('@/lib/use-client-id', () => ({ useClientId: () => 'client-1' }));
const player = vi.hoisted(() => ({ playback: null as unknown }));
vi.mock('@/components/player/player-provider', () => ({
  usePlayerContext: () => ({ playback: player.playback, engagedSource: null, pending: null }),
  usePlayerActions: () => ({ engage: vi.fn(), beginOtherMusic: async () => true }),
}));

afterEach(() => {
  player.playback = null;
  cleanup();
  toast.dismiss();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function session(n: number, overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: uuid(n),
    title: `Session ${n}`,
    coverImageId: null,
    lastActiveAt: '2026-07-18T10:00:00.000Z',
    status: 'stopped',
    trackCount: 2,
    totalDurationSeconds: 360,
    genreTags: [],
    pinned: false,
    ...overrides,
  };
}

function activeSummary(n: number, title: string) {
  return {
    id: uuid(n),
    status: 'active',
    title,
    generationStatus: 'ok',
    generationStatusScope: null,
    sessionMode: 'repeat',
    coverImageId: null,
    statusMessageSafe: null,
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:00.000Z',
  };
}

function renderList(items: SessionListItem[], nextCursor: string | null = null) {
  render(
    createElement(MySessionsList as FunctionComponent<{ initial: ResumableSessionsInitialData }>, {
      initial: { items, activeSession: null, nextCursor, pinned: [] },
    }),
  );
}

function stubApi(hits: SessionListItem[], responses: Record<string, unknown> = {}) {
  const fetcher = vi.fn(async (url: string) => ({
    json: async () => {
      if (url.startsWith('/api/search')) {
        return {
          ok: true,
          data: {
            query: 'rain',
            scope: 'sessions',
            sort: 'relevance',
            lyrics: false,
            sessions: {
              items: hits.map((hit) => ({
                ...hit,
                matchContext: { field: 'tracks', snippet: 'Rain on glass' },
              })),
              matchCount: hits.length,
              truncated: false,
            },
            tracks: null,
            playlists: null,
          },
        };
      }
      return responses[url];
    },
  }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

async function expectErrorToast(message: string) {
  await waitFor(() =>
    expect(shownToasts()).toEqual([expect.objectContaining({ tone: 'error', message })]),
  );
  expect(screen.queryByRole('alert')).toBeNull();
}

function type(query: string) {
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: query } });
}

/**
 * Lets the search box's debounce elapse on a fake clock and settles the search
 * inside `act`, so the results are on screen when this returns. Waiting it out
 * in real time spends the debounce from a findBy's wall-clock budget, which a
 * loaded machine overruns.
 */
async function settleSearch(commit: () => void) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    commit();
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  } finally {
    vi.useRealTimers();
  }
}

const openOptions = (title: string) =>
  fireEvent.click(screen.getByRole('button', { name: `Options for ${title}` }));

describe('My Sessions search', () => {
  it('asks for Sessions only and swaps the sections for what matched, until cleared', async () => {
    const fetcher = stubApi([session(2, { title: 'Rainy Drive' })]);
    renderList([session(1, { title: 'Quiet Morning' }), session(2, { title: 'Rainy Drive' })]);
    expect(screen.getByRole('heading', { name: 'History' })).toBeTruthy();

    await settleSearch(() => type('rain'));
    expect(screen.getByText(/on glass/)).toBeTruthy();
    expect(screen.queryByText('Quiet Morning')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'History' })).toBeNull();
    const [searchUrl] = fetcher.mock.calls.find(([url]) => url.startsWith('/api/search'))!;
    expect(new URL(searchUrl, 'http://localhost').searchParams.get('scope')).toBe('sessions');

    await settleSearch(() => fireEvent.click(screen.getByRole('button', { name: 'Clear search' })));
    expect(screen.getByText('Quiet Morning')).toBeTruthy();
  });

  async function deleteFirstResultThenServe(remaining: SessionListItem[]) {
    const hits = [session(50, { title: 'Rainy Drive' })];
    const fetcher = stubApi(hits, {
      '/api/sessions/delete': { ok: true, data: { id: uuid(50) } },
    });
    renderList([session(1, { title: 'Quiet Morning' })]);
    await settleSearch(() => type('rain'));
    expect(screen.getByText(/on glass/)).toBeTruthy();

    openOptions('Rainy Drive');
    fireEvent.click(await screen.findByTestId('delete-session'));
    hits.splice(0, hits.length, ...remaining);
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(screen.queryByText('Rainy Drive')).toBeNull());
    expect(fetcher.mock.calls.some(([url]) => url === '/api/sessions/delete')).toBe(true);
  }

  it('keeps the options menu working on a result: a delete removes the row', async () => {
    await deleteFirstResultThenServe([]);
    await screen.findByText(/No Sessions match/);
  });

  it('re-reads a capped search after a delete, so a held-back match takes the free slot', async () => {
    await deleteFirstResultThenServe([session(51, { title: 'Held Back Rain' })]);
    await screen.findByText('Held Back Rain');
  });
});

describe('My Sessions active card', () => {
  it('reloads the list when playback moves to a Session it has not loaded', async () => {
    const live = activeSummary(70, 'Found by search');
    player.playback = { session: live, player: { sessionCoverImageId: null } };
    const fetcher = vi.fn(async () => ({
      json: async () => ({
        ok: true,
        data: {
          items: [],
          nextCursor: null,
          pinned: [],
          activeSession: {
            ...live,
            trackCount: 6,
            totalDurationSeconds: 1080,
            genreTags: ['lofi'],
          },
        },
      }),
    }));
    vi.stubGlobal('fetch', fetcher);
    renderList([session(1)]);
    await screen.findByText('6 Tracks · 18 min');
    expect(screen.getByText('Lo-fi')).toBeTruthy();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('My Sessions with a stopped live Session', () => {
  it('gives Active now to the server-known Session and lists the stopped one in History', async () => {
    const stopped = activeSummary(70, 'Stopped on the player');
    const running = activeSummary(80, 'Running elsewhere');
    player.playback = {
      session: stopped,
      player: { sessionCoverImageId: null, sessionStatus: 'stopped' },
    };
    const fetcher = vi.fn(async () => ({
      json: async () => ({
        ok: true,
        data: {
          items: [session(70, { title: 'Stopped on the player' }), session(1)],
          nextCursor: null,
          pinned: [],
          activeSession: { ...running, trackCount: 3, totalDurationSeconds: 540, genreTags: [] },
        },
      }),
    }));
    vi.stubGlobal('fetch', fetcher);
    render(
      createElement(
        MySessionsList as FunctionComponent<{ initial: ResumableSessionsInitialData }>,
        {
          initial: {
            items: [session(1)],
            activeSession: {
              ...stopped,
              trackCount: 2,
              totalDurationSeconds: 360,
              genreTags: [],
            } as ResumableSessionsInitialData['activeSession'],
            nextCursor: null,
            pinned: [],
          },
        },
      ),
    );

    const history = await screen.findByRole('region', { name: /History/ });
    expect(await within(history).findByText('Stopped on the player')).toBeTruthy();
    expect(within(history).getByLabelText('Options for Stopped on the player')).toBeTruthy();
    const activeNow = screen.getByRole('region', { name: 'Active now' });
    expect(within(activeNow).getByText('Running elsewhere')).toBeTruthy();
    expect(within(activeNow).queryByText('Stopped on the player')).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('My Sessions delete', () => {
  it('keeps the Session and says why in an error toast when the delete fails', async () => {
    stubApi([], {
      '/api/sessions/delete': {
        ok: false,
        error: { code: 'internal_error', message: 'Could not delete.', retryable: true },
      },
    });
    renderList([session(1, { title: 'Quiet Morning' })]);
    openOptions('Quiet Morning');
    fireEvent.click(await screen.findByTestId('delete-session'));
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await expectErrorToast('Could not delete.');
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    expect(screen.getByTestId('delete-session')).toBeTruthy();
  });
});

describe('My Sessions Resume', () => {
  const resumed = activeSummary(1, 'Quiet Morning');
  const clickResume = async () => {
    renderList([session(1, { title: 'Quiet Morning' })]);
    openOptions('Quiet Morning');
    fireEvent.click(await screen.findByRole('button', { name: /^Resume Session/ }));
  };

  it('closes the options once the Session is playing, so they offer no stale actions', async () => {
    stubApi([], {
      '/api/sessions/resume': {
        ok: true,
        data: { session: resumed, supersededSessionId: null },
      },
    });
    await clickResume();
    await waitFor(() => expect(screen.queryByTestId('delete-session')).toBeNull());
  });

  it('keeps the options open and says why in an error toast when the Resume fails', async () => {
    stubApi([], {
      '/api/sessions/resume': {
        ok: false,
        error: { code: 'internal_error', message: 'Could not resume.', retryable: true },
      },
    });
    await clickResume();
    await expectErrorToast('Could not resume.');
    expect(screen.getByTestId('delete-session')).toBeTruthy();
  });
});

describe('My Sessions Convert to Playlist', () => {
  it('opens the new Playlist once converted', async () => {
    const playlistId = uuid(900);
    stubApi([], {
      '/api/sessions/convert-to-playlist': { ok: true, data: { playlistId, trackCount: 2 } },
    });
    renderList([session(1, { title: 'Quiet Morning' })]);
    openOptions('Quiet Morning');
    fireEvent.click(await screen.findByTestId('convert-session-to-playlist'));
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith(`/library/playlist/${playlistId}`),
    );
  });

  it('stays put and says why in an error toast when the conversion fails', async () => {
    stubApi([], {
      '/api/sessions/convert-to-playlist': {
        ok: false,
        error: {
          code: 'validation_error',
          message: 'This Session has no Tracks yet.',
          retryable: false,
        },
      },
    });
    renderList([session(1, { title: 'Quiet Morning' })]);
    openOptions('Quiet Morning');
    fireEvent.click(await screen.findByTestId('convert-session-to-playlist'));
    await expectErrorToast('This Session has no Tracks yet.');
    expect(navigation.push).not.toHaveBeenCalled();
  });
});

describe('My Sessions on a phone', () => {
  const cardFor = (title: string) =>
    screen.getByRole('button', { name: new RegExp(`^${title} `) }).closest('article')!;
  const hiddenOnPhone = (element: Element) => element.className.includes('max-desk:hidden');
  const loadMore = () => screen.getByRole('button', { name: 'Load more' }).parentElement!;

  it('shows ten History Sessions, and ten more per Load more', () => {
    renderList(Array.from({ length: 23 }, (_, index) => session(index + 1)));
    expect(hiddenOnPhone(cardFor('Session 10'))).toBe(false);
    expect(hiddenOnPhone(cardFor('Session 11'))).toBe(true);
    // Every loaded Session already shows on a desk, so the button is the phone's alone.
    expect(loadMore().className).toContain('desk:hidden');

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(hiddenOnPhone(cardFor('Session 20'))).toBe(false);
    expect(hiddenOnPhone(cardFor('Session 21'))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(hiddenOnPhone(cardFor('Session 23'))).toBe(false);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('keeps paging while fewer than ten are loaded', () => {
    renderList([session(1)], 'next-page');
    expect(hiddenOnPhone(loadMore())).toBe(false);
    expect(loadMore().className).not.toContain('desk:hidden');
  });
});
