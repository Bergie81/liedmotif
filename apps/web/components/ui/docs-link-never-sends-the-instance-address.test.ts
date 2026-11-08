// A private instance's address must not reach the website: every docs link
// opens in a new tab with no referrer, whatever the app's Referrer-Policy says.

import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DocsLink } from './docs-link';

describe('a docs link', () => {
  it('opens the docs page in a new tab without a referrer', () => {
    const html = renderToStaticMarkup(
      h(DocsLink, { path: 'backups', children: 'How backups work' }),
    );

    expect(html).toContain('href="https://liedmotif.com/docs/backups/"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('(opens in a new tab)');
  });
});
