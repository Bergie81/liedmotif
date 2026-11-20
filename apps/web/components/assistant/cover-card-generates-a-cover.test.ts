// @vitest-environment jsdom

// A cover card in the chat, and the click on it: the card is worded from its
// values with the cover budget line the cover dialog shows, and confirming
// sends the regenerate request the cover dialog sends. The dock is wired to
// the app as the app shell wires it; the cover routes are a stubbed `fetch`.

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeApiError, type AssistantCard, type SessionCoverUsage } from '@liedmotif/shared';
import { askForCard, cardEvent, type SentRequest } from '@/tests/helpers/assistant-card-chat';

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
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const PLAYLIST_ID = '00000000-0000-4000-8000-000000000002';
const ATTEMPT_ID = '00000000-0000-4000-8000-000000000009';

const RAINY: AssistantCard = {
  kind: 'cover',
  subject: { kind: 'session', id: SESSION_ID, name: 'Rainy Window' },
  guidance: 'darker, neon city',
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

/** The cover status route's answer for a Session, as the cover dialog reads it. */
const sessionStatus = (usage: SessionCoverUsage) =>
  Response.json({
    ok: true,
    data: {
      coverImageId: null,
      coverStyle: 'auto',
      generating: false,
      latestRegeneration: null,
      usage,
      history: [],
      peopleReferencesAvailable: false,
    },
  });

const playlistStatus = (usage: SessionCoverUsage) =>
  Response.json({
    ok: true,
    data: {
      coverImageId: null,
      generating: false,
      latestRegeneration: null,
      usage,
      history: [],
      peopleReferencesAvailable: false,
    },
  });

const started = () =>
  Response.json({ ok: true, data: { outcome: 'started', coverGenerationId: ATTEMPT_ID } });

const coverCard = () => screen.getByRole('group', { name: 'New Cover' });
const generateButton = () => screen.getByRole('button', { name: 'Generate Cover' });

/** The requests a click sent to a regenerate route; the budget read goes elsewhere. */
const regenerations = (sent: SentRequest[]) => sent.filter(({ path }) => /regenerate/.test(path));

describe('a cover card in the chat', () => {
  it('shows what the cover is for, the art direction, the cover dialog’s budget line and one button', async () => {
    const { card, server } = await askForCard('New Cover', [cardEvent(RAINY)]);

    expect(server.sent.map(({ path, body }) => ({ path, body }))).toEqual([
      { path: '/api/sessions/cover/status', body: { activitySessionId: SESSION_ID } },
    ]);
    server.sent[0]!.answer(sessionStatus(USAGE));

    expect(card.textContent).toContain('For the session Rainy Window');
    expect(card.textContent).toContain('“darker, neon city”');
    expect(card.textContent).toContain('Generating uses one cover from your budget.');
    await waitFor(() => expect(coverCard().textContent).toContain('Covers today: 3 of 10.'));
    expect(card.textContent).not.toContain('Tracks left');
    expect(within(card).getAllByRole('button')).toEqual([generateButton()]);
  });

  it('names the month too when it is the window that binds', async () => {
    const { server } = await askForCard('New Cover', [cardEvent(RUNNING)]);

    expect(server.sent[0]!.path).toBe(`/api/playlists/cover/status?playlistId=${PLAYLIST_ID}`);
    server.sent[0]!.answer(playlistStatus({ ...USAGE, usedMonth: 22 }));

    await waitFor(() =>
      expect(coverCard().textContent).toContain('Covers today: 3 of 10 · This month: 22 of 25.'),
    );
  });
});

describe('confirming a cover card', () => {
  it('sends the cover dialog’s regenerate request once, then says the cover is being generated', async () => {
    const { server } = await askForCard('New Cover', [cardEvent(RAINY)]);
    server.sent[0]!.answer(sessionStatus(USAGE));

    const button = generateButton();
    fireEvent.click(button);
    fireEvent.click(button);

    const sent = regenerations(server.sent);
    expect(sent.map(({ path, body }) => ({ path, body }))).toEqual([
      {
        path: '/api/sessions/cover/regenerate',
        body: { activitySessionId: SESSION_ID, guidance: 'darker, neon city' },
      },
    ]);
    sent[0]!.answer(started());

    await waitFor(() =>
      expect(coverCard().textContent).toContain(
        'Generating the new cover. It will be under Previous Covers.',
      ),
    );
    expect(within(coverCard()).queryByRole('button')).toBeNull();
    expect(regenerations(server.sent)).toHaveLength(1);
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it('sends a Playlist’s request to the Playlist route, with nothing the card does not carry', async () => {
    const { server } = await askForCard('New Cover', [cardEvent(RUNNING)]);

    fireEvent.click(generateButton());

    expect(regenerations(server.sent).map(({ path, body }) => ({ path, body }))).toEqual([
      { path: '/api/playlists/cover/regenerate', body: { playlistId: PLAYLIST_ID } },
    ]);
  });

  it('shows the route’s refusal on the card in the app’s words', async () => {
    const { server } = await askForCard('New Cover', [cardEvent(RAINY)]);
    fireEvent.click(generateButton());

    regenerations(server.sent)[0]!.answer(
      Response.json(
        makeApiError('limit_reached', 'The cover generation limit is reached for this window.'),
        { status: 429 },
      ),
    );

    await waitFor(() =>
      expect(coverCard().textContent).toContain(
        'The cover generation limit is reached for this window.',
      ),
    );
    expect(within(coverCard()).queryByRole('button')).toBeNull();
  });
});
