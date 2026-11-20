// @vitest-environment jsdom

// A confirmed cover card, after the click: it follows the attempt through the
// cover status route, shows the new cover once it is ready, and makes it the
// cover only when "Use this cover" is tapped. The dock is wired to the app as
// the app shell wires it; the cover routes are a stubbed `fetch`.

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeApiError,
  type AssistantCard,
  type SessionCoverAttempt,
  type SessionCoverUsage,
} from '@liedmotif/shared';
import {
  askAgain,
  askForCard,
  cardEvent,
  type SentRequest,
} from '@/tests/helpers/assistant-card-chat';

const navigation = vi.hoisted(() => ({
  push: vi.fn<(path: string) => void>(),
  refresh: vi.fn<() => void>(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));

const player = vi.hoisted(() => ({
  beginStart: vi.fn<() => void>(),
  engage: vi.fn<(session: unknown, options: unknown) => void>(),
}));
vi.mock('@/components/player/player-provider', () => ({
  usePlayerActions: () => player,
  usePlayerContext: () => ({
    ...player,
    playback: null,
    submitChangeVibe: () => null,
    vibeChange: { pendingSessionId: null, error: null },
  }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const PLAYLIST_ID = '00000000-0000-4000-8000-000000000002';
const ATTEMPT_ID = '00000000-0000-4000-8000-000000000009';
const OTHER_ATTEMPT_ID = '00000000-0000-4000-8000-000000000008';
const CURRENT_COVER = '00000000-0000-4000-8000-0000000000c1';
const NEW_COVER = '00000000-0000-4000-8000-0000000000c2';
const OTHER_COVER = '00000000-0000-4000-8000-0000000000c3';

const RAINY: AssistantCard = {
  kind: 'cover',
  subject: { kind: 'session', id: SESSION_ID, name: 'Rainy Window' },
};
const RUNNING: AssistantCard = {
  kind: 'cover',
  subject: { kind: 'playlist', id: PLAYLIST_ID, name: 'Running' },
};

const USAGE: SessionCoverUsage = {
  usedDay: 3,
  limitDay: 10,
  usedMonth: 7,
  limitMonth: 25,
  remaining: 7,
  oneTime: false,
  enabled: true,
  providerConfigured: true,
  sunoFallbackActive: false,
};

const attempt = (
  status: SessionCoverAttempt['status'],
  more: Partial<SessionCoverAttempt> = {},
): SessionCoverAttempt => ({
  coverGenerationId: ATTEMPT_ID,
  coverImageId: NEW_COVER,
  status,
  failureMessageSafe: null,
  ...more,
});

const historyEntry = (coverImageId: string, isCurrent: boolean) => ({
  coverImageId,
  style: 'photo',
  createdAt: '2026-11-17T10:00:00.000Z',
  isCurrent,
});

interface Covers {
  current?: string | null;
  latest?: SessionCoverAttempt | null;
  history?: string[];
}

/** The cover status route's answer, as the cover dialog and the playlist cover sheet read it. */
function coverStatus(
  kind: 'session' | 'playlist',
  { current = CURRENT_COVER, latest = null, history = [CURRENT_COVER] }: Covers,
) {
  const common = {
    coverImageId: current,
    generating: latest?.status === 'generating',
    latestRegeneration: latest,
    usage: USAGE,
    history: history.map((id) => historyEntry(id, id === current)),
    peopleReferencesAvailable: false,
  };
  return Response.json({
    ok: true,
    data: kind === 'session' ? { ...common, coverStyle: 'auto' } : common,
  });
}

const regenerated = (outcome: 'started' | 'pending', coverGenerationId = ATTEMPT_ID) =>
  Response.json({ ok: true, data: { outcome, coverGenerationId } });

const SUBJECTS = [
  {
    what: 'a Session',
    card: RAINY,
    kind: 'session' as const,
    selectPath: '/api/sessions/cover/select',
    select: { activitySessionId: SESSION_ID, coverImageId: NEW_COVER },
  },
  {
    what: 'a Playlist',
    card: RUNNING,
    kind: 'playlist' as const,
    selectPath: '/api/playlists/cover/select',
    select: { playlistId: PLAYLIST_ID, coverImageId: NEW_COVER },
  },
];

const coverCard = () => screen.getByRole('group', { name: 'New Cover' });
const statusReads = (sent: SentRequest[]) => sent.filter(({ path }) => /cover\/status/.test(path));
const selects = (sent: SentRequest[]) => sent.filter(({ path }) => /cover\/select/.test(path));
const shownCover = () => coverCard().querySelector('img')?.getAttribute('src') ?? null;

/** Closes the chat with the panel's own close button. */
const closeChat = () =>
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close Roadie' }));

/** Asks for `card`, answers its budget read, confirms it and answers the regenerate request. */
async function confirmCover(
  card: AssistantCard,
  answer: Response = regenerated('started'),
  options?: Parameters<typeof askForCard>[2],
) {
  const asked = await askForCard('New Cover', [cardEvent(card)], options);
  const kind = card.kind === 'cover' ? card.subject.kind : 'session';
  asked.server.sent[0]!.answer(coverStatus(kind, {}));
  fireEvent.click(screen.getByRole('button', { name: 'Generate Cover' }));
  asked.server.sent.find(({ path }) => /regenerate/.test(path))!.answer(answer);
  return asked;
}

/** The status reads sent after the budget read, once there are `count` of them. */
async function attemptReads(sent: SentRequest[], count: number) {
  await waitFor(() => expect(statusReads(sent).length).toBe(count + 1));
  return statusReads(sent).slice(1);
}

describe.each(SUBJECTS)(
  'a confirmed cover card for $what',
  ({ card, kind, selectPath, select }) => {
    it('shows the new cover once it is ready, with one button to use it', async () => {
      const { server } = await confirmCover(card);

      const [read] = await attemptReads(server.sent, 1);
      read!.answer(
        coverStatus(kind, { latest: attempt('ready'), history: [NEW_COVER, CURRENT_COVER] }),
      );

      await waitFor(() => expect(shownCover()).toBe(`/api/covers/${NEW_COVER}`));
      expect(coverCard().textContent).toContain('The new cover is ready.');
      expect(
        within(coverCard())
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(['Use This Cover']);
    });

    it('sends the cover select request once, then says the cover is in use and the app’s views follow', async () => {
      const { server, refresh } = await confirmCover(card);
      (await attemptReads(server.sent, 1))[0]!.answer(
        coverStatus(kind, { latest: attempt('ready'), history: [NEW_COVER, CURRENT_COVER] }),
      );
      const use = await screen.findByRole('button', { name: 'Use This Cover' });
      const chromeReads = refresh.mock.calls.length;

      fireEvent.click(use);
      fireEvent.click(use);

      const sent = selects(server.sent);
      expect(sent.map(({ path, body }) => ({ path, body }))).toEqual([
        { path: selectPath, body: select },
      ]);
      sent[0]!.answer(Response.json({ ok: true, data: { coverImageId: NEW_COVER } }));

      await waitFor(() => expect(coverCard().textContent).toContain('This cover is in use.'));
      expect(within(coverCard()).queryByRole('button')).toBeNull();
      expect(selects(server.sent)).toHaveLength(1);
      expect(navigation.refresh).toHaveBeenCalled();
      expect(refresh.mock.calls.length).toBeGreaterThan(chromeReads);
    });

    it('sends nothing more when the card is left alone', async () => {
      const { server } = await confirmCover(card);
      (await attemptReads(server.sent, 1))[0]!.answer(
        coverStatus(kind, { latest: attempt('ready'), history: [NEW_COVER, CURRENT_COVER] }),
      );
      await screen.findByRole('button', { name: 'Use This Cover' });

      expect(selects(server.sent)).toEqual([]);
      expect(navigation.refresh).not.toHaveBeenCalled();
    });

    it('shows the attempt’s failure in the app’s words', async () => {
      const { server } = await confirmCover(card);

      (await attemptReads(server.sent, 1))[0]!.answer(
        coverStatus(kind, {
          latest: attempt('failed', { failureMessageSafe: 'The image provider is unavailable.' }),
        }),
      );

      await waitFor(() =>
        expect(coverCard().textContent).toContain('The image provider is unavailable.'),
      );
      expect(within(coverCard()).queryByRole('button')).toBeNull();
      expect(shownCover()).toBeNull();
    });
  },
);

describe('following a cover attempt', () => {
  it('reads the status again with the cover dialog’s pace while the cover is generating', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { server } = await confirmCover(RAINY);
    (await attemptReads(server.sent, 1))[0]!.answer(
      coverStatus('session', { latest: attempt('generating') }),
    );
    await waitFor(() => expect(coverCard().textContent).toContain('Generating the new cover.'));

    await act(() => vi.advanceTimersByTimeAsync(3000));
    (await attemptReads(server.sent, 2))[1]!.answer(
      coverStatus('session', { latest: attempt('ready'), history: [NEW_COVER, CURRENT_COVER] }),
    );

    await screen.findByRole('button', { name: 'Use This Cover' });
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(statusReads(server.sent)).toHaveLength(3);
  });

  it('stops reading while the chat is closed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { server } = await confirmCover(RAINY);
    (await attemptReads(server.sent, 1))[0]!.answer(
      coverStatus('session', { latest: attempt('generating') }),
    );
    await waitFor(() => expect(coverCard().textContent).toContain('Generating the new cover.'));

    closeChat();
    await act(() => vi.advanceTimersByTimeAsync(30_000));

    expect(statusReads(server.sent)).toHaveLength(2);
  });

  it('follows the attempt already running when the regenerate route answers that one is pending', async () => {
    const { server } = await confirmCover(RAINY, regenerated('pending', OTHER_ATTEMPT_ID));

    (await attemptReads(server.sent, 1))[0]!.answer(
      coverStatus('session', {
        latest: attempt('ready', { coverGenerationId: OTHER_ATTEMPT_ID }),
        history: [NEW_COVER, CURRENT_COVER],
      }),
    );

    await screen.findByRole('button', { name: 'Use This Cover' });
    expect(shownCover()).toBe(`/api/covers/${NEW_COVER}`);
  });
});

describe('a cover attempt the status route no longer tells of', () => {
  const NO_LONGER_TOLD =
    'This card can no longer tell how the cover went. If it was generated, it is under Previous Covers.';

  it('settles on a line pointing to Previous Covers when a later attempt came first', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { server } = await confirmCover(RAINY);

    (await attemptReads(server.sent, 1))[0]!.answer(
      coverStatus('session', {
        latest: attempt('ready', { coverGenerationId: OTHER_ATTEMPT_ID }),
        history: [NEW_COVER, CURRENT_COVER],
      }),
    );

    await waitFor(() => expect(coverCard().textContent).toContain(NO_LONGER_TOLD));
    expect(within(coverCard()).queryByRole('button')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(statusReads(server.sent)).toHaveLength(2);
  });

  it('does not call a cover deleted that a later attempt replaced while it was generating', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { server } = await confirmCover(RAINY);
    (await attemptReads(server.sent, 1))[0]!.answer(
      coverStatus('session', { latest: attempt('generating') }),
    );
    await waitFor(() => expect(coverCard().textContent).toContain('Generating the new cover.'));

    await act(() => vi.advanceTimersByTimeAsync(3000));
    (await attemptReads(server.sent, 2))[1]!.answer(
      coverStatus('session', {
        latest: attempt('generating', {
          coverGenerationId: OTHER_ATTEMPT_ID,
          coverImageId: OTHER_COVER,
        }),
      }),
    );

    await waitFor(() => expect(coverCard().textContent).toContain(NO_LONGER_TOLD));
    expect(coverCard().textContent).not.toContain('deleted');
  });

  it('shows the app’s refusal and stops reading when the Session is gone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { server } = await confirmCover(RAINY);

    (await attemptReads(server.sent, 1))[0]!.answer(
      Response.json(makeApiError('not_found', 'Session not found.'), { status: 404 }),
    );

    await waitFor(() => expect(coverCard().textContent).toContain('Session not found.'));
    expect(within(coverCard()).queryByRole('button')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(statusReads(server.sent)).toHaveLength(2);
  });

  it('tells the next request what the card says', async () => {
    const { server } = await confirmCover(RAINY);
    (await attemptReads(server.sent, 1))[0]!.answer(
      Response.json(makeApiError('not_found', 'Session not found.'), { status: 404 }),
    );
    await waitFor(() => expect(coverCard().textContent).toContain('Session not found.'));

    askAgain('Where is it?');

    await waitFor(() => expect(server.asked).toHaveLength(2));
    expect(server.asked[1]![1]).toBe(
      '[Card shown by the app: generate one new cover for the Session "Rainy Window". The user confirmed it, but the app can no longer read the covers it was for, and the card told them why.]',
    );
  });
});

describe('a cover card shown again', () => {
  /** Closes the chat and opens it again: the card comes back from the conversation. */
  function reopen() {
    closeChat();
    fireEvent.click(screen.getByRole('button', { name: 'Ask Roadie' }));
  }

  it('reads the status again and shows a cover that became the cover elsewhere as in use', async () => {
    const { server } = await confirmCover(RAINY);
    (await attemptReads(server.sent, 1))[0]!.answer(
      coverStatus('session', { latest: attempt('ready'), history: [NEW_COVER, CURRENT_COVER] }),
    );
    await screen.findByRole('button', { name: 'Use This Cover' });

    reopen();
    (await attemptReads(server.sent, 2))[1]!.answer(
      coverStatus('session', {
        current: NEW_COVER,
        latest: attempt('ready'),
        history: [NEW_COVER, CURRENT_COVER],
      }),
    );

    await waitFor(() => expect(coverCard().textContent).toContain('This cover is in use.'));
    expect(within(coverCard()).queryByRole('button')).toBeNull();
  });

  it('shows no button for a cover deleted from the history', async () => {
    const { server } = await confirmCover(RAINY);
    (await attemptReads(server.sent, 1))[0]!.answer(
      coverStatus('session', { latest: attempt('ready'), history: [NEW_COVER, CURRENT_COVER] }),
    );
    await screen.findByRole('button', { name: 'Use This Cover' });

    reopen();
    (await attemptReads(server.sent, 2))[1]!.answer(
      coverStatus('session', { latest: attempt('ready'), history: [CURRENT_COVER] }),
    );

    await waitFor(() =>
      expect(coverCard().textContent).toContain('This cover was deleted from Previous Covers.'),
    );
    expect(within(coverCard()).queryByRole('button')).toBeNull();
  });
});

describe('what the next request is told of a cover card', () => {
  it('says the user used the new cover', async () => {
    const { server } = await confirmCover(RAINY);
    (await attemptReads(server.sent, 1))[0]!.answer(
      coverStatus('session', { latest: attempt('ready'), history: [NEW_COVER, CURRENT_COVER] }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Use This Cover' }));
    selects(server.sent)[0]!.answer(Response.json({ ok: true, data: { coverImageId: NEW_COVER } }));
    await waitFor(() => expect(coverCard().textContent).toContain('This cover is in use.'));

    askAgain('Nice.');

    await waitFor(() => expect(server.asked).toHaveLength(2));
    expect(server.asked[1]![1]).toBe(
      '[Card shown by the app: generate one new cover for the Session "Rainy Window". The user confirmed it and used the new cover, so it is the cover now.]',
    );
  });

  it('says a cover left alone did not replace the current one', async () => {
    const { server } = await confirmCover(RAINY);
    (await attemptReads(server.sent, 1))[0]!.answer(
      coverStatus('session', { latest: attempt('ready'), history: [NEW_COVER, CURRENT_COVER] }),
    );
    await screen.findByRole('button', { name: 'Use This Cover' });

    askAgain('Hm.');

    await waitFor(() => expect(server.asked).toHaveLength(2));
    expect(server.asked[1]![1]).toBe(
      '[Card shown by the app: generate one new cover for the Session "Rainy Window". The user confirmed it, and the new cover is ready on the card. The user has not used it, so the current cover stays and the new one is in the cover history.]',
    );
  });

  it('says the card no longer tells how the cover went', async () => {
    const { server } = await confirmCover(RAINY);
    (await attemptReads(server.sent, 1))[0]!.answer(
      coverStatus('session', {
        latest: attempt('failed', { coverGenerationId: OTHER_ATTEMPT_ID }),
      }),
    );
    await waitFor(() => expect(coverCard().textContent).toContain('Previous Covers'));

    askAgain('And?');

    await waitFor(() => expect(server.asked).toHaveLength(2));
    expect(server.asked[1]![1]).toBe(
      '[Card shown by the app: generate one new cover for the Session "Rainy Window". The user confirmed it, but a later cover attempt came after it, so the app no longer tells how this one went. If it was generated, it is in the cover history.]',
    );
  });

  it('says the cover failed', async () => {
    const { server } = await confirmCover(RAINY);
    (await attemptReads(server.sent, 1))[0]!.answer(
      coverStatus('session', { latest: attempt('failed') }),
    );
    await waitFor(() => expect(coverCard().textContent).toContain('No cover was generated'));

    askAgain('Why?');

    await waitFor(() => expect(server.asked).toHaveLength(2));
    expect(server.asked[1]![1]).toBe(
      '[Card shown by the app: generate one new cover for the Session "Rainy Window". The user confirmed it, but the cover failed to generate, and the card told them why.]',
    );
  });
});

describe('a failed cover select', () => {
  it('shows the route’s refusal and keeps the button', async () => {
    const { server } = await confirmCover(RAINY);
    (await attemptReads(server.sent, 1))[0]!.answer(
      coverStatus('session', { latest: attempt('ready'), history: [NEW_COVER, CURRENT_COVER] }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Use This Cover' }));

    selects(server.sent)[0]!.answer(
      Response.json(
        makeApiError('not_found', 'This cover is not part of the session’s cover history.'),
        { status: 404 },
      ),
    );

    await waitFor(() =>
      expect(coverCard().textContent).toContain(
        'This cover is not part of the session’s cover history.',
      ),
    );
    expect(screen.getByRole('button', { name: 'Use This Cover' })).toBeTruthy();
  });
});
