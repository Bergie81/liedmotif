// @vitest-environment jsdom

// A Surprise Me card in the chat, and the click on it: the card is worded from
// its values, and confirming runs the start flow Home's Surprise Me runs. The
// dock is wired to the app as the app shell wires it; the Surprise Me start
// route is a stubbed `fetch`, and the player's two entry points are spies.

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeApiError, type AssistantCard, type SessionSummary } from '@liedmotif/shared';
import { cancelPendingStart, takeUnshownStartRefusal } from '@/components/player/session-handoff';
import { askForCard, cardEvent } from '@/tests/helpers/assistant-card-chat';

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
  usePlayerContext: () => ({ ...player, playback: null, submitChangeVibe: () => null }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  cancelPendingStart();
  takeUnshownStartRefusal();
});

const HARBOR: AssistantCard = {
  kind: 'surprise',
  suggestion: {
    id: '00000000-0000-4000-8000-000000000004',
    adventurous: false,
    title: 'Harbor Morning',
    mood: 'hazy',
    genres: ['lofi', 'jazz'],
    energy: 'low',
    vocalMode: 'instrumental',
    voiceGender: null,
    language: null,
  },
  targetDurationMinutes: 45,
};

const STARTED: SessionSummary = {
  id: '00000000-0000-4000-8000-000000000001',
  status: 'active',
  title: 'Harbor Morning',
  createdAt: '2026-11-17T10:00:00Z',
  updatedAt: '2026-11-17T10:00:00Z',
  generationStatus: 'ok',
  generationStatusScope: null,
  sessionMode: 'keep_going',
  coverImageId: null,
  statusMessageSafe: null,
  targetDurationMinutes: 45,
  generatedDurationSeconds: 0,
  unknownDurationTrackCount: 0,
};

const askForSurpriseCard = () => askForCard('Surprise Me', [cardEvent(HARBOR)]);

const startButton = () => screen.getByRole('button', { name: 'Start Session' });

const started = () =>
  Response.json({ ok: true, data: { session: STARTED, supersededSessionId: null } });

const surpriseCard = () => screen.getByRole('group', { name: 'Surprise Me' });

describe('a Surprise Me card in the chat', () => {
  it('shows the suggestion, the budget line the other cards show, and one button', async () => {
    const { card, server } = await askForSurpriseCard();

    expect(card.textContent).toContain('Harbor Morning');
    expect(card.textContent).toContain(
      'Familiar · Lo-fi, Jazz · hazy · Low energy · Instrumental · 45 min',
    );
    expect(card.textContent).toContain('Starting generates new Tracks from your budget.');
    expect(card.textContent).toContain('38 Tracks left today');
    expect(within(card).getAllByRole('button')).toEqual([startButton()]);
    expect(server.sent).toEqual([]);
  });
});

describe('confirming a Surprise Me card', () => {
  it('runs Home’s Surprise Me start: audio primed in the click, the suggestion to its start route, on to the Player', async () => {
    const { server } = await askForSurpriseCard();

    fireEvent.click(startButton());

    expect(player.beginStart).toHaveBeenCalledTimes(1);
    expect(server.sent).toHaveLength(1);
    expect(server.sent[0]!.path).toBe('/api/surprise-me/start');
    expect(server.sent[0]!.body).toEqual({
      proposalId: '00000000-0000-4000-8000-000000000004',
      targetDurationMinutes: 45,
    });
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith('/player');

    server.sent[0]!.answer(started());

    await waitFor(() => expect(player.engage).toHaveBeenCalledWith(STARTED, { autoplay: true }));
    await waitFor(() => expect(surpriseCard().textContent).toContain('Session started'));
    expect(within(surpriseCard()).queryByRole('button')).toBeNull();
  });

  it('works once: a second click sends no second request', async () => {
    const { server } = await askForSurpriseCard();
    const button = startButton();

    fireEvent.click(button);
    fireEvent.click(button);
    server.sent[0]!.answer(started());
    await waitFor(() => expect(player.engage).toHaveBeenCalledTimes(1));

    expect(server.sent).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Start Session' })).toBeNull();
  });

  it.each([
    [
      'a suggestion replaced or dismissed elsewhere',
      makeApiError('conflict', 'This suggestion is no longer available. Ask for a new one.'),
      409,
    ],
    [
      'a budget used up since the card was shown',
      makeApiError(
        'session_headroom_blocked',
        'You have reached your generation headroom for now.',
      ),
      429,
    ],
  ])('shows the app’s refusal of %s on the card', async (_what, error, status) => {
    const { server } = await askForSurpriseCard();
    fireEvent.click(startButton());

    server.sent[0]!.answer(Response.json(error, { status }));

    await waitFor(() => expect(surpriseCard().textContent).toContain(error.error.message));
    expect(within(surpriseCard()).queryByRole('button')).toBeNull();
    expect(player.engage).not.toHaveBeenCalled();
  });
});
