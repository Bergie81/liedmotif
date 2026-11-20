// @vitest-environment jsdom

// An answer is text a model wrote. It may format; it may not put anything on
// the page that loads or runs, and it leads only where the user's link targets
// say it may.

import { createElement as h } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DOCS_BASE_URL } from '@/lib/docs-links';
import type { AnswerLinkTargets } from '@/lib/assistant/answer-links';
import { AnswerLinksContext, AssistantMarkdown } from './assistant-markdown';

afterEach(cleanup);

/** What a Member may be sent to: no admin page. */
const MEMBER_TARGETS: AnswerLinkTargets = {
  appPaths: ['/library', '/settings/playback'],
  docsPages: ['index', 'backups', 'members'],
};

const onOpenAppPage = vi.fn<(path: string) => void>();
afterEach(() => onOpenAppPage.mockClear());

function renderAnswer(
  markdown: string,
  { streaming = false, targets = MEMBER_TARGETS } = {},
): HTMLElement {
  return render(
    h(
      AnswerLinksContext.Provider,
      { value: { targets, onOpenAppPage } },
      h(AssistantMarkdown, { streaming, children: markdown }),
    ),
  ).container;
}

it('formats an answer written in Markdown', () => {
  const answer = renderAnswer(
    'Open **Settings › Members**.\n\n1. Create an invite link\n2. Send it\n\nUse `New Music` to keep going.',
  );

  expect(answer.querySelector('strong')?.textContent).toBe('Settings › Members');
  expect([...answer.querySelectorAll('ol > li')].map((item) => item.textContent)).toEqual([
    'Create an invite link',
    'Send it',
  ]);
  expect(answer.querySelector('code')?.textContent).toBe('New Music');
});

it("turns a link to a page on the user's route map into a button that opens it", () => {
  const answer = renderAnswer('Set it in [Settings › Playback](/settings/playback).');

  const button = answer.querySelector('button')!;
  expect(button.textContent).toBe('Settings › Playback');
  expect(answer.querySelector('a')).toBeNull();
  expect(onOpenAppPage).not.toHaveBeenCalled();

  fireEvent.click(button);

  expect(onOpenAppPage).toHaveBeenCalledExactlyOnceWith('/settings/playback');
});

it('opens a known docs page on the website, in a new tab', () => {
  const answer = renderAnswer('More in [Members and invites](/docs/members#invite-someone).');

  const link = answer.querySelector('a')!;
  expect(link.textContent).toBe('Members and invites');
  expect(link.getAttribute('href')).toBe(`${DOCS_BASE_URL}members/#invite-someone`);
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  expect(answer.querySelector('button')).toBeNull();
});

it('shows every other link as its text, with nothing to click', () => {
  const answer = renderAnswer(
    [
      'Go to [Settings › Members](/settings/members), [a page](/settings/teleport)',
      'or [the Library](/library?next=//example.com), read https://example.com/docs,',
      '[the manual](https://example.com/docs/members) and [this](javascript:alert(1)).',
    ].join(' '),
  );

  expect(answer.querySelector('a, button')).toBeNull();
  expect(answer.innerHTML).not.toContain('href');
  expect(answer.textContent).toBe(
    'Go to Settings › Members, a page or the Library, read https://example.com/docs, the manual and this.',
  );
});

it('has nothing to click in the other ways Markdown writes a link', () => {
  const source = [
    'See <https://example.com/a>, [the docs][docs], mail <someone@example.com>.',
    'A note.[^1]',
    '[docs]: javascript:alert(1)',
    '[^1]: With [a link](https://example.com/b).',
  ].join('\n\n');

  for (const streaming of [false, true]) {
    const answer = renderAnswer(source, { streaming });

    expect(answer.querySelector('a, button, [href], [src]')).toBeNull();
    expect(answer.innerHTML).not.toContain('javascript:');
    cleanup();
  }
});

it('follows no link at all where no link targets are given', () => {
  const answer = render(
    h(AssistantMarkdown, {
      children: 'Open [Library](/library) or read [Backups](/docs/backups).',
    }),
  ).container;

  expect(answer.querySelector('a, button')).toBeNull();
  expect(answer.textContent).toBe('Open Library or read Backups.');
});

it('never loads an image the model points at', () => {
  const answer = renderAnswer('Here: ![the Members screen](https://example.com/pixel.png)');

  expect(answer.querySelector('img')).toBeNull();
  expect(answer.innerHTML).not.toContain('example.com');
  expect(answer.textContent).toBe('Here: the Members screen');
});

it('keeps HTML the model wrote as plain text', () => {
  const answer = renderAnswer(
    [
      'Inline <img src="https://example.com/x.png" onerror="alert(1)"> and <a href="https://example.com">a link</a>.',
      '<script>alert(1)</script>',
      '<iframe src="https://example.com"></iframe>',
      '<div onclick="alert(1)">block</div>',
    ].join('\n\n'),
  );

  expect(answer.querySelector('img, a, script, iframe, [onclick], [onerror], [src]')).toBeNull();
  expect(answer.textContent).toContain('<script>alert(1)</script>');
  expect(answer.textContent).toContain('<a href="https://example.com">a link</a>');
});

it('shows a code block as code only, whatever the model writes after the opening fence', () => {
  const answer = renderAnswer(
    'Run this:\n\n```bash style="color:red" id="main" onclick="alert(1)"\nnpm run docs:sync\n```',
  );

  expect(answer.querySelector('pre code')?.textContent).toBe('npm run docs:sync');
  expect(answer.querySelector('[style], [id], [onclick]')).toBeNull();
});

it('hides half-written syntax while the answer is still arriving', () => {
  const answer = renderAnswer('Open **Settings › Mem', { streaming: true });

  expect(answer.textContent).not.toContain('**');
});

it('shows no button for a link whose target is still being written', () => {
  const answer = renderAnswer('Open [Library](/libr', { streaming: true });

  expect(answer.querySelector('a, button')).toBeNull();
});
