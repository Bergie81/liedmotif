// The Assistant's chat with a card in it, wired to the app as the app shell
// wires it. The chat route and every route a confirmed card may reach are one
// stubbed `fetch`: an answer to a question is scripted, and a request a click
// sends waits for the test to answer it. The test file mocks the router and
// the player provider itself.

import { createElement as h } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import {
  ASSISTANT_STREAM_CONTENT_TYPE,
  assistantRequestSchema,
  encodeAssistantStreamEvent,
  type AssistantCard,
  type AssistantStreamEvent,
} from '@liedmotif/shared';
import type { GenerationHeadroom } from '@/components/app-shell-model';
import { useCardHost } from '@/components/assistant/use-card-host';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ShellAssistant } from '@/tests/helpers/shell-assistant';

const LEFT_TODAY: GenerationHeadroom = {
  remainingTracks: 38,
  remainingRatio: 0.38,
  window: 'day',
  critical: false,
};

/** One request a click sent to a route of the app, and the function that answers it. */
export interface SentRequest {
  path: string;
  body: unknown;
  signal: AbortSignal | undefined;
  answer(response: Response): void;
}

/** The app's side of the wire. */
export interface Server {
  /** The conversation each question carried. */
  asked: string[][];
  /** Every request that did not go to the chat route, in order. */
  sent: SentRequest[];
}

/** Answers every question with `events`; any other request waits for the test to answer it. */
function serve(events: AssistantStreamEvent[]): Server {
  const server: Server = { asked: [], sent: [] };
  const reply = [...events, { type: 'done' } as const].map(encodeAssistantStreamEvent).join('');
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init: { body?: string; signal?: AbortSignal }) => {
      if (path === '/api/assistant') {
        const { messages } = assistantRequestSchema.parse(JSON.parse(init.body!));
        server.asked.push(messages.map(({ content }) => content));
        return Promise.resolve(
          new Response(reply, { headers: { 'Content-Type': ASSISTANT_STREAM_CONTENT_TYPE } }),
        );
      }
      return new Promise<Response>((answer) => {
        server.sent.push({
          path,
          body: init.body === undefined ? undefined : JSON.parse(init.body),
          signal: init.signal,
          answer,
        });
      });
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
    h(ShellAssistant, { links: { appPaths: [], docsPages: [] }, cards }),
  );
}

/**
 * Opens the chat and asks; the answer is `events`. Resolves with the card
 * titled `title` that it showed. `desk` false is the phone, where the panel
 * covers the page.
 */
export async function askForCard(
  title: string,
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
  fireEvent.click(screen.getByRole('button', { name: 'Ask Roadie' }));
  fireEvent.click(screen.getByRole('button', { name: 'Play something calm for reading' }));
  const card = await screen.findByRole('group', { name: title });
  return { server, refresh, card };
}

/** Asks one more question in the open chat. */
export function askAgain(text: string): void {
  fireEvent.change(screen.getByRole('textbox', { name: 'Ask Roadie' }), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

export const cardEvent = (card: AssistantCard): AssistantStreamEvent => ({
  type: 'action',
  action: { status: 'proposed', card },
});
