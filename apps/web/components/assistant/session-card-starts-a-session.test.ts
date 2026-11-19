// @vitest-environment jsdom

// A Session card in the chat, and the click on it: the card is worded from its
// values, and confirming runs the start flow Home's own button runs. The dock
// is wired to the app as the app shell wires it; the start route is a stubbed
// `fetch`, and the player's two entry points are spies.

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeApiError,
  type AssistantCard,
  type AssistantStreamEvent,
  type SessionSummary,
} from '@liedmotif/shared';
import {
  beginPendingStart,
  cancelPendingStart,
  takeUnshownStartRefusal,
} from '@/components/player/session-handoff';
import { askAgain, askForCard, cardEvent } from '@/tests/helpers/assistant-card-chat';

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
  cancelPendingStart();
  takeUnshownStartRefusal();
});

const CALM: AssistantCard = {
  kind: 'session',
  prompt: 'calm piano for reading',
  vocal: 'instrumental',
  targetDurationMinutes: 45,
};

const STARTED: SessionSummary = {
  id: '00000000-0000-4000-8000-000000000001',
  status: 'active',
  title: 'Quiet Pages',
  createdAt: '2026-11-10T10:00:00Z',
  updatedAt: '2026-11-10T10:00:00Z',
  generationStatus: 'ok',
  generationStatusScope: null,
  sessionMode: 'keep_going',
  coverImageId: null,
  statusMessageSafe: null,
  targetDurationMinutes: 45,
  generatedDurationSeconds: 0,
  unknownDurationTrackCount: 0,
};

const askForSessionCard = (
  events: AssistantStreamEvent[],
  options?: Parameters<typeof askForCard>[2],
) => askForCard('Start a new Session', events, options);

const startButton = () => screen.getByRole('button', { name: 'Start Session' });

const started = () =>
  Response.json({ ok: true, data: { session: STARTED, supersededSessionId: null } });

const refused = () =>
  Response.json(makeApiError('session_headroom_blocked', 'You have reached your headroom.'), {
    status: 429,
  });

describe('a Session card in the chat', () => {
  it('is worded from its values, with the budget line the player shows and one button', async () => {
    const { card, refresh } = await askForSessionCard([
      cardEvent(CALM),
      { type: 'text', text: 'I started a loud metal Session for you.' },
    ]);

    expect(card.textContent).toContain('calm piano for reading');
    expect(card.textContent).toContain('Instrumental · 45 min');
    expect(card.textContent).toContain('Starting generates new Tracks from your budget.');
    expect(card.textContent).toContain('38 Tracks left today');
    expect(card.textContent).not.toContain('metal');
    expect(within(card).getAllByRole('button')).toEqual([startButton()]);
    // The figure is read again for the card, as the player's own sheet does.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows no budget line where no limit counts down', async () => {
    const { card } = await askForSessionCard([cardEvent(CALM)], { headroom: null });

    expect(card.textContent).not.toMatch(/left/);
    expect(startButton()).toBeTruthy();
  });

  it('starts nothing until it is clicked', async () => {
    const { server } = await askForSessionCard([cardEvent(CALM)]);

    expect(server.sent).toEqual([]);
    expect(player.beginStart).not.toHaveBeenCalled();
    expect(navigation.push).not.toHaveBeenCalled();
  });
});

describe('confirming a Session card', () => {
  it('runs Home’s start: audio primed in the click, the card’s values to the start route, on to the Player', async () => {
    const { server } = await askForSessionCard([cardEvent(CALM)]);

    fireEvent.click(startButton());

    // Inside the click: the browser lets audio start only from the gesture.
    expect(player.beginStart).toHaveBeenCalledTimes(1);
    expect(server.sent).toHaveLength(1);
    expect(server.sent[0]!.path).toBe('/api/sessions');
    expect(server.sent[0]!.body).toEqual({
      input: { mode: 'prompt', prompt: 'calm piano for reading', vocal: 'instrumental' },
      targetDurationMinutes: 45,
      clientId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith('/player');
    // Beside the page, the chat stays while the Player narrates the start.
    expect(screen.getByRole('dialog', { name: 'Roadie' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Starting…' })).toHaveProperty('disabled', true);

    server.sent[0]!.answer(started());

    await waitFor(() => expect(player.engage).toHaveBeenCalledWith(STARTED, { autoplay: true }));
    const card = screen.getByRole('group', { name: 'Start a new Session' });
    await waitFor(() => expect(card.textContent).toContain('Session started'));
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it('closes the panel that covers the page, so the Player shows', async () => {
    await askForSessionCard([cardEvent(CALM)], { desk: false });

    fireEvent.click(startButton());

    expect(navigation.push).toHaveBeenCalledExactlyOnceWith('/player');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says it did not start when the app refuses, and leaves the reason to the Player', async () => {
    const { server } = await askForSessionCard([cardEvent(CALM)]);
    fireEvent.click(startButton());

    server.sent[0]!.answer(refused());

    const card = screen.getByRole('group', { name: 'Start a new Session' });
    await waitFor(() => expect(card.textContent).toContain('This Session did not start'));
    expect(within(card).queryByRole('button')).toBeNull();
    expect(player.engage).not.toHaveBeenCalled();
    // Where a refused Start from Home waits to be shown: the Player takes it.
    expect(takeUnshownStartRefusal()).toMatchObject({
      ok: false,
      error: { code: 'session_headroom_blocked', message: 'You have reached your headroom.' },
    });
  });

  it('works once: a second click sends no second request', async () => {
    const { server } = await askForSessionCard([cardEvent(CALM)]);
    const button = startButton();

    fireEvent.click(button);
    fireEvent.click(button);
    server.sent[0]!.answer(started());
    await waitFor(() => expect(player.engage).toHaveBeenCalledTimes(1));

    expect(server.sent).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Start Session' })).toBeNull();
  });

  it('sends nothing while another Start is still in flight, and stays to be confirmed', async () => {
    const { server } = await askForSessionCard([cardEvent(CALM)]);
    // A Start from Home that has not settled.
    beginPendingStart(() => new Promise(() => {}), vi.fn());

    fireEvent.click(startButton());

    expect(server.sent).toEqual([]);
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith('/player');
    expect(startButton()).toHaveProperty('disabled', false);
  });

  it('tells the next request what the user did with the card', async () => {
    const { server } = await askForSessionCard([cardEvent(CALM)]);
    askAgain('And now?');
    await waitFor(() => expect(server.asked).toHaveLength(2));
    expect(server.asked[1]![1]).toMatch(
      /The user has not confirmed it, so it has not happened\.\]$/,
    );

    // The first card of the conversation; the second answer brought another.
    fireEvent.click(screen.getAllByRole('button', { name: 'Start Session' })[0]!);
    server.sent[0]!.answer(started());
    await waitFor(() => expect(player.engage).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy());
    askAgain('Thanks.');

    await waitFor(() => expect(server.asked).toHaveLength(3));
    expect(server.asked[2]![1]).toMatch(
      /^\[Card shown by the app: start a new Session from "calm piano for reading", instrumental, 45 minutes\. The user confirmed it, and the app carried it out\.\]$/,
    );
  });
});
