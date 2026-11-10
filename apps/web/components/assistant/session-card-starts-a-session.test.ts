// @vitest-environment jsdom

// A Session card in the chat, and the click on it: the card is worded from its
// values, and confirming runs the start flow Home's own button runs. The dock
// is wired to the app as the app shell wires it; the start route is a stubbed
// `fetch`, and the player's two entry points are spies.

import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASSISTANT_STREAM_CONTENT_TYPE,
  assistantRequestSchema,
  encodeAssistantStreamEvent,
  makeApiError,
  type AssistantCard,
  type AssistantStreamEvent,
  type SessionSummary,
} from '@liedmotif/shared';
import type { GenerationHeadroom } from '@/components/app-shell-model';
import {
  beginPendingStart,
  cancelPendingStart,
  takeUnshownStartRefusal,
} from '@/components/player/session-handoff';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AssistantDock } from './assistant-dock';
import { useCardHost } from './use-card-host';

const navigation = vi.hoisted(() => ({
  push: vi.fn<(path: string) => void>(),
  refresh: vi.fn<() => void>(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));

const player = vi.hoisted(() => ({
  beginStart: vi.fn<() => void>(),
  engage: vi.fn<(session: unknown, options: unknown) => void>(),
}));
vi.mock('@/components/player/player-provider', () => ({ usePlayerActions: () => player }));

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

const LEFT_TODAY: GenerationHeadroom = {
  remainingTracks: 38,
  remainingRatio: 0.38,
  window: 'day',
  critical: false,
};

/** The app's side of the wire: what the chat was sent, and the start requests the click made. */
interface Server {
  /** The conversation each question carried. */
  asked: string[][];
  /** Every request to the start route, with the function that answers it. */
  starts: { body: unknown; signal: AbortSignal; answer(response: Response): void }[];
}

/** Answers every question with `events`; a start request waits for the test to answer it. */
function serve(events: AssistantStreamEvent[]): Server {
  const server: Server = { asked: [], starts: [] };
  const reply = [...events, { type: 'done' } as const].map(encodeAssistantStreamEvent).join('');
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init: { body: string; signal: AbortSignal }) => {
      if (path === '/api/assistant') {
        const { messages } = assistantRequestSchema.parse(JSON.parse(init.body));
        server.asked.push(messages.map(({ content }) => content));
        return Promise.resolve(
          new Response(reply, { headers: { 'Content-Type': ASSISTANT_STREAM_CONTENT_TYPE } }),
        );
      }
      if (path === '/api/sessions') {
        return new Promise<Response>((answer) => {
          server.starts.push({ body: JSON.parse(init.body), signal: init.signal, answer });
        });
      }
      throw new Error(`Unexpected request to ${path}`);
    }),
  );
  return server;
}

/** The dock inside what the app shell gives it for cards. */
function Shell({
  headroom,
  refresh,
}: {
  headroom: GenerationHeadroom | null;
  refresh: () => void;
}) {
  const cards = useCardHost(headroom, refresh);
  return h(
    TooltipProvider,
    null,
    h(AssistantDock, { links: { appPaths: [], docsPages: [] }, cards }),
  );
}

/** Opens the chat and asks; the answer is `events`. Resolves with the card it showed. */
async function askForCard(
  events: AssistantStreamEvent[],
  {
    desk = true,
    headroom = LEFT_TODAY,
  }: { desk?: boolean; headroom?: GenerationHeadroom | null } = {},
) {
  vi.stubGlobal(
    'matchMedia',
    () => ({ matches: desk, addEventListener: () => {}, removeEventListener: () => {} }) as never,
  );
  const server = serve(events);
  const refresh = vi.fn();
  render(h(Shell, { headroom, refresh }));
  fireEvent.click(screen.getByRole('button', { name: 'Ask Mo' }));
  fireEvent.click(screen.getByRole('button', { name: 'What does New music do?' }));
  const card = await screen.findByRole('group', { name: 'Start a new Session' });
  return { server, refresh, card };
}

const cardEvent = (card: AssistantCard): AssistantStreamEvent => ({
  type: 'action',
  action: { status: 'proposed', card },
});

const startButton = () => screen.getByRole('button', { name: 'Start Session' });

const started = () =>
  Response.json({ ok: true, data: { session: STARTED, supersededSessionId: null } });

const refused = () =>
  Response.json(makeApiError('session_headroom_blocked', 'You have reached your headroom.'), {
    status: 429,
  });

describe('a Session card in the chat', () => {
  it('is worded from its values, with the budget line the player shows and one button', async () => {
    const { card, refresh } = await askForCard([
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
    const { card } = await askForCard([cardEvent(CALM)], { headroom: null });

    expect(card.textContent).not.toMatch(/left/);
    expect(startButton()).toBeTruthy();
  });

  it('starts nothing until it is clicked', async () => {
    const { server } = await askForCard([cardEvent(CALM)]);

    expect(server.starts).toEqual([]);
    expect(player.beginStart).not.toHaveBeenCalled();
    expect(navigation.push).not.toHaveBeenCalled();
  });
});

describe('confirming a Session card', () => {
  it('runs Home’s start: audio primed in the click, the card’s values to the start route, on to the Player', async () => {
    const { server } = await askForCard([cardEvent(CALM)]);

    fireEvent.click(startButton());

    // Inside the click: the browser lets audio start only from the gesture.
    expect(player.beginStart).toHaveBeenCalledTimes(1);
    expect(server.starts).toHaveLength(1);
    expect(server.starts[0]!.body).toEqual({
      input: { mode: 'prompt', prompt: 'calm piano for reading', vocal: 'instrumental' },
      targetDurationMinutes: 45,
      clientId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith('/player');
    // Beside the page, the chat stays while the Player narrates the start.
    expect(screen.getByRole('dialog', { name: 'Mo' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Starting…' })).toHaveProperty('disabled', true);

    server.starts[0]!.answer(started());

    await waitFor(() => expect(player.engage).toHaveBeenCalledWith(STARTED, { autoplay: true }));
    const card = screen.getByRole('group', { name: 'Start a new Session' });
    await waitFor(() => expect(card.textContent).toContain('Session started'));
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it('closes the panel that covers the page, so the Player shows', async () => {
    await askForCard([cardEvent(CALM)], { desk: false });

    fireEvent.click(startButton());

    expect(navigation.push).toHaveBeenCalledExactlyOnceWith('/player');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says it did not start when the app refuses, and leaves the reason to the Player', async () => {
    const { server } = await askForCard([cardEvent(CALM)]);
    fireEvent.click(startButton());

    server.starts[0]!.answer(refused());

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
    const { server } = await askForCard([cardEvent(CALM)]);
    const button = startButton();

    fireEvent.click(button);
    fireEvent.click(button);
    server.starts[0]!.answer(started());
    await waitFor(() => expect(player.engage).toHaveBeenCalledTimes(1));

    expect(server.starts).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Start Session' })).toBeNull();
  });

  it('sends nothing while another Start is still in flight, and stays to be confirmed', async () => {
    const { server } = await askForCard([cardEvent(CALM)]);
    // A Start from Home that has not settled.
    beginPendingStart(() => new Promise(() => {}), vi.fn());

    fireEvent.click(startButton());

    expect(server.starts).toEqual([]);
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith('/player');
    expect(startButton()).toHaveProperty('disabled', false);
  });

  it('tells the next request what the user did with the card', async () => {
    const { server } = await askForCard([cardEvent(CALM)]);
    const ask = (text: string) => {
      fireEvent.change(screen.getByRole('textbox', { name: 'Ask Mo' }), {
        target: { value: text },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    };

    ask('And now?');
    await waitFor(() => expect(server.asked).toHaveLength(2));
    expect(server.asked[1]![1]).toMatch(
      /The user has not confirmed it, so it has not happened\.\]$/,
    );

    // The first card of the conversation; the second answer brought another.
    fireEvent.click(screen.getAllByRole('button', { name: 'Start Session' })[0]!);
    server.starts[0]!.answer(started());
    await waitFor(() => expect(player.engage).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy());
    ask('Thanks.');

    await waitFor(() => expect(server.asked).toHaveLength(3));
    expect(server.asked[2]![1]).toMatch(
      /^\[Card shown by the app: start a new Session from "calm piano for reading", instrumental, 45 minutes\. The user confirmed it, and the app carried it out\.\]$/,
    );
  });
});
