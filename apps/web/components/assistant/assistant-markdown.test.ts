// @vitest-environment jsdom

// An answer is text a model wrote. It may format; it may not put anything on
// the page that loads, runs or leads somewhere.

import { createElement as h } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AssistantMarkdown } from './assistant-markdown';

afterEach(cleanup);

function renderAnswer(markdown: string): HTMLElement {
  return render(h(AssistantMarkdown, { children: markdown })).container;
}

it('formats an answer written in Markdown', () => {
  const answer = renderAnswer(
    'Open **Settings › Members**.\n\n1. Create an invite link\n2. Send it\n\nUse `New music` to keep going.',
  );

  expect(answer.querySelector('strong')?.textContent).toBe('Settings › Members');
  expect([...answer.querySelectorAll('ol > li')].map((item) => item.textContent)).toEqual([
    'Create an invite link',
    'Send it',
  ]);
  expect(answer.querySelector('code')?.textContent).toBe('New music');
});

it('shows a link as its text, with nothing to click', () => {
  const answer = renderAnswer(
    'Go to [Settings › Members](/settings/members), or read https://example.com/docs and [this](javascript:alert(1)).',
  );

  expect(answer.querySelector('a')).toBeNull();
  expect(answer.innerHTML).not.toContain('href');
  expect(answer.textContent).toBe(
    'Go to Settings › Members, or read https://example.com/docs and this.',
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
    const answer = render(h(AssistantMarkdown, { streaming, children: source })).container;

    expect(answer.querySelector('a, [href], [src]')).toBeNull();
    expect(answer.innerHTML).not.toContain('javascript:');
    cleanup();
  }
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

it('hides half-written syntax while the answer is still arriving', () => {
  const answer = render(
    h(AssistantMarkdown, { streaming: true, children: 'Open **Settings › Mem' }),
  ).container;

  expect(answer.textContent).not.toContain('**');
});
