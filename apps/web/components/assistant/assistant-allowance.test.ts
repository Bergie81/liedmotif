// @vitest-environment jsdom

// What the panel tells a Member about their daily message allowance: nothing
// while plenty is left, a count once it runs low, and a closed field when it
// is used up.

import { createElement as h } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ASSISTANT_STANDING_HEADER,
  ASSISTANT_STREAM_CONTENT_TYPE,
  encodeAssistantStreamEvent,
  makeApiError,
  type AssistantStanding,
} from '@liedmotif/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AnswerLinkTargets } from '@/lib/assistant/answer-links';
import { ShellAssistant } from '@/tests/helpers/shell-assistant';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

/** No answer here carries a link. */
const NO_LINKS: AnswerLinkTargets = { appPaths: [], docsPages: [] };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A Member's standing with `remaining` of 30 messages left, the day ending at `resetsAt`. */
function memberStanding(
  remaining: number,
  resetsAt: Date = new Date(Date.now() + 3 * 60 * 60_000),
): AssistantStanding {
  return {
    enabled: true,
    allowance: { dailyMessages: 30, remaining, resetsAt: resetsAt.toISOString() },
  };
}

/** Opens the panel for a user the server rendered with `standing`. */
function openPanel(standing: AssistantStanding | null): HTMLElement {
  vi.stubGlobal(
    'matchMedia',
    () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }) as never,
  );
  render(h(TooltipProvider, null, h(ShellAssistant, { links: NO_LINKS, standing })));
  fireEvent.click(screen.getByRole('button', { name: 'Ask Roadie' }));
  return screen.getByRole('dialog', { name: 'Roadie' });
}

const field = () => screen.getByRole('textbox', { name: 'Ask Roadie' }) as HTMLTextAreaElement;

it.each([
  { remaining: 5, line: '5 messages left today.' },
  { remaining: 1, line: '1 message left today.' },
])('says "$line" once the allowance runs low', ({ remaining, line }) => {
  const panel = openPanel(memberStanding(remaining));

  expect(panel.textContent).toContain(line);
  expect(field().disabled).toBe(false);
});

it.each([
  { viewer: 'a Member with plenty left', standing: memberStanding(6) },
  { viewer: 'the Admin, who has no allowance', standing: { enabled: true, allowance: null } },
  { viewer: 'a viewer whose standing is not known', standing: null },
])('says nothing about an allowance to $viewer', ({ standing }) => {
  const panel = openPanel(standing);

  expect(panel.textContent).not.toMatch(/left today|used all/);
  expect(field().disabled).toBe(false);
});

it('closes the field when the allowance is used up, and says when it opens again', () => {
  // Five past four in the afternoon, wherever the viewer is.
  const panel = openPanel(memberStanding(0, new Date(2099, 0, 1, 16, 5)));

  expect(panel.textContent).toMatch(
    /You have used all of today's messages\. You can ask again at (16:05|4:05\sPM)\./,
  );
  expect(field().disabled).toBe(true);
  expect(
    (screen.getByRole('button', { name: 'How do I create new music?' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it('opens the field again when the next day starts', () => {
  vi.useFakeTimers();
  const panel = openPanel(memberStanding(0, new Date(Date.now() + 60_000)));
  expect(field().disabled).toBe(true);

  act(() => {
    vi.advanceTimersByTime(60_000);
  });

  expect(field().disabled).toBe(false);
  expect(panel.textContent).not.toMatch(/left today|used all/);
});

it('learns from a refusal that the allowance is used up', async () => {
  const usedUp = memberStanding(0);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(makeApiError('assistant_allowance_used_up', 'The server said why.'), {
        status: 429,
        headers: { [ASSISTANT_STANDING_HEADER]: JSON.stringify(usedUp) },
      }),
    ),
  );
  const panel = openPanel(memberStanding(20));
  fireEvent.change(field(), { target: { value: 'How do I invite someone?' } });

  fireEvent.click(screen.getByRole('button', { name: 'Send' }));

  await waitFor(() => expect(field().disabled).toBe(true));
  expect(panel.textContent).toContain("You have used all of today's messages.");
  // One line says it; the refusal's own wording is not shown beside it.
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(panel.textContent).not.toContain('The server said why.');
  // The question nobody answered waits in the field for tomorrow.
  expect(field().value).toBe('How do I invite someone?');
});

it.each([
  {
    failure: 'a refusal before any answer',
    respond: (headers: Record<string, string>) =>
      Response.json(makeApiError('provider_error', 'The Writing AI gave no answer.', true), {
        status: 502,
        headers,
      }),
    notice: 'The Writing AI gave no answer.',
  },
  {
    failure: 'an answer that broke off',
    respond: (headers: Record<string, string>) =>
      new Response(
        encodeAssistantStreamEvent({ type: 'text', text: 'To invite someone, open' }) +
          encodeAssistantStreamEvent({
            type: 'error',
            error: makeApiError('provider_error', 'Roadie could not answer.', true).error,
          }),
        { headers: { 'Content-Type': ASSISTANT_STREAM_CONTENT_TYPE, ...headers } },
      ),
    notice: 'Roadie could not answer.',
  },
])(
  'says why the last message of the day got no whole answer: $failure',
  async ({ respond, notice }) => {
    const headers = { [ASSISTANT_STANDING_HEADER]: JSON.stringify(memberStanding(0)) };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(headers)),
    );
    const panel = openPanel(memberStanding(1));
    fireEvent.change(field(), { target: { value: 'How do I invite someone?' } });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(field().disabled).toBe(true));
    expect(panel.textContent).toContain(notice);
    expect(panel.textContent).toContain("You have used all of today's messages.");
  },
);

it("says so when the server refuses for a day the viewer's own clock has already ended", async () => {
  // The viewer's clock runs ahead of the server's: the day it was told about
  // is over here, and the server still counts against it.
  const overHere = memberStanding(0, new Date(Date.now() - 60_000));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(makeApiError('assistant_allowance_used_up', 'The server said why.'), {
        status: 429,
        headers: { [ASSISTANT_STANDING_HEADER]: JSON.stringify(overHere) },
      }),
    ),
  );
  const panel = openPanel(overHere);
  expect(field().disabled).toBe(false);
  fireEvent.change(field(), { target: { value: 'How do I invite someone?' } });

  fireEvent.click(screen.getByRole('button', { name: 'Send' }));

  await waitFor(() => expect(panel.textContent).toContain('The server said why.'));
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(field().value).toBe('How do I invite someone?');
});

it('learns from an answer how many messages are left', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          encodeAssistantStreamEvent({ type: 'text', text: 'Open Members.' }) +
            encodeAssistantStreamEvent({ type: 'done' }),
          {
            headers: {
              'Content-Type': ASSISTANT_STREAM_CONTENT_TYPE,
              [ASSISTANT_STANDING_HEADER]: JSON.stringify(memberStanding(2)),
            },
          },
        ),
    ),
  );
  const panel = openPanel(memberStanding(20));
  fireEvent.change(field(), { target: { value: 'How do I invite someone?' } });

  fireEvent.click(screen.getByRole('button', { name: 'Send' }));

  await waitFor(() => expect(panel.textContent).toContain('2 messages left today.'));
  expect(field().disabled).toBe(false);
});

it('takes a fresher standing from the server over the one it had', () => {
  vi.stubGlobal(
    'matchMedia',
    () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }) as never,
  );
  const dock = (standing: AssistantStanding) =>
    h(TooltipProvider, null, h(ShellAssistant, { links: NO_LINKS, standing }));
  const { rerender } = render(dock(memberStanding(0)));
  fireEvent.click(screen.getByRole('button', { name: 'Ask Roadie' }));
  expect(field().disabled).toBe(true);

  // The Admin raised the allowance, and the page was rendered again.
  rerender(dock(memberStanding(10)));

  expect(field().disabled).toBe(false);
});
