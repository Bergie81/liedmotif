import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCS_PATHS, docsUrl } from './docs-links';

describe('docsUrl', () => {
  it('builds the docs home, a page and a heading anchor', () => {
    expect(docsUrl()).toBe('https://liedmotif.com/docs/');
    expect(docsUrl('backups')).toBe('https://liedmotif.com/docs/backups/');
    expect(docsUrl('providers-and-keys#when-credits-run-out')).toBe(
      'https://liedmotif.com/docs/providers-and-keys/#when-credits-run-out',
    );
  });
});

// The website's repo, checked out next to this one. CI has only this repo, so
// the check skips there and runs wherever both are present.
const siteDocsDir = fileURLToPath(
  new URL('../../../../../liedmotif-landingpage/src/content/docs/', import.meta.url),
);

describe.skipIf(!existsSync(siteDocsDir))('every docs link the app uses', () => {
  // Read in the tests, not here: Vitest collects a skipped suite's body too.
  let pages: Map<string, string[]> | undefined;

  function expectOnSite(path: string): void {
    pages ??= readSitePages(siteDocsDir);
    const [page = '', anchor] = path.split('#');
    const headings = pages.get(page);
    expect(headings, `no docs page at /docs/${page}`).toBeDefined();
    if (anchor) expect(headings, `no #${anchor} on /docs/${page}`).toContain(anchor);
  }

  it.each(DOCS_PATHS)('"%s" names a page and heading on the website', expectOnSite);

  it('includes the ones written out in shipped scripts and config', () => {
    const urls = execFileSync(
      'git',
      ['grep', '--untracked', '-ohE', 'liedmotif\\.com/docs/[A-Za-z0-9/#_-]*', '--', ':!*.md'],
      { cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8' },
    );
    for (const url of new Set(urls.split('\n').filter(Boolean))) {
      // `page/#anchor` → `page#anchor`, the shape DOCS_PATHS uses.
      expectOnSite(url.replace('liedmotif.com/docs/', '').replace(/\/(?=#|$)/, ''));
    }
  });
});

/** Page path (`x/y`, `''` for the home) → its `##`/`###` heading anchors. */
function readSitePages(dir: string): Map<string, string[]> {
  const pages = new Map<string, string[]>();
  for (const file of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    if (!file.endsWith('.md')) continue;
    const page = file
      .replace(/\\/g, '/')
      .replace(/\.md$/, '')
      .replace(/(^|\/)index$/, '');
    pages.set(page, headingAnchors(readFileSync(join(dir, file), 'utf8')));
  }
  return pages;
}

/** GitHub-style slugs, the ids the website's Markdown renderer gives headings. */
function headingAnchors(markdown: string): string[] {
  const seen = new Map<string, number>();
  const anchors: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    const match = inFence ? null : /^#{2,3} (.+)$/.exec(line);
    if (!match?.[1]) continue;
    const text = match[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '');
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_ -]/gu, '')
      .replace(/ /g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.push(count ? `${base}-${count}` : base);
  }
  return anchors;
}
