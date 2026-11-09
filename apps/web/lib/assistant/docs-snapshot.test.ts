import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDocsIndex, docsSnapshotDir, loadDocs, readDocsFiles } from './docs';
import { SECTIONS_READ_CHAR_BUDGET } from './read-docs-tool';

describe('the committed docs snapshot', () => {
  it('loads every page with a title, a description and sections', () => {
    const pages = loadDocs();

    expect(pages.map((page) => page.slug)).toContain('install/local');
    for (const page of pages) {
      expect(page.title, `${page.slug} has no title`).not.toBe('');
      expect(page.description, `${page.slug} has no description`).not.toBe('');
      expect(page.sections.length, `${page.slug} has no sections`).toBeGreaterThan(0);
    }
  });

  it('gives every section of a page its own id', () => {
    for (const page of loadDocs()) {
      const ids = page.sections.map((section) => section.id);
      expect(ids, `${page.slug} repeats a section heading`).toEqual([...new Set(ids)]);
      expect(ids, `${page.slug} has a heading with no words`).not.toContain('');
    }
  });
});

// One Assistant turn has to fit a 16k-token context, so that a local model can
// run it: about 4k for the system prompt, 4k for the conversation, 6k for the
// sections read and 1k for the answer. The docs index is most of the system
// prompt.
const INDEX_TOKEN_BUDGET = 3_000;

/**
 * No tokenizer ships with the app, so sizes are estimated from length. The docs
 * measure 3.7 to 4.6 characters per token under OpenAI's tokenizers; 3.5 leaves
 * room for a model whose tokenizer splits finer.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

describe("the docs snapshot within one turn's context budget", () => {
  it('keeps the docs index small enough for the system prompt', () => {
    expect(estimateTokens(buildDocsIndex(loadDocs()))).toBeLessThanOrEqual(INDEX_TOKEN_BUDGET);
  });

  it('has no section too large to read in one turn', () => {
    const oversized = loadDocs().flatMap((page) =>
      page.sections
        .filter((section) => section.markdown.length > SECTIONS_READ_CHAR_BUDGET)
        .map(
          (section) => `${page.slug} › ${section.heading}: ${section.markdown.length} characters`,
        ),
    );

    // A section is never cut to fit: the fix is to split it on the website.
    expect(oversized, `over ${SECTIONS_READ_CHAR_BUDGET} characters`).toEqual([]);
  });
});

// The website's repo, checked out next to this one. CI has only this repo, so
// the check skips there and runs wherever both are present.
const siteDocsDir = fileURLToPath(
  new URL('../../../../../../liedmotif-landingpage/src/content/docs/', import.meta.url),
);

describe.skipIf(!existsSync(siteDocsDir))('the docs snapshot and the website docs', () => {
  const refresh = 'run `npm run docs:sync` and commit the result';

  it('hold the same pages with the same content', () => {
    const snapshot = readDocsFiles(docsSnapshotDir());
    const site = readDocsFiles(siteDocsDir);

    expect([...snapshot.keys()], `the page list differs: ${refresh}`).toEqual([...site.keys()]);
    for (const [slug, source] of site) {
      // Compared as a boolean: a whole page as the diff would bury the message.
      expect(snapshot.get(slug) === source, `${slug} differs from the website: ${refresh}`).toBe(
        true,
      );
    }
  });
});
