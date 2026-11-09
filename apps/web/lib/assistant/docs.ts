// The user docs the Assistant answers from (server-only): the committed copy of
// the website's docs pages, split into sections it can load one at a time.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DocsSection {
  /** `intro`, or the heading's anchor slug (`invite-someone`). */
  id: string;
  /** The `##` heading as written; `intro` for the text before the first one. */
  heading: string;
  /** The section's Markdown, heading line included. */
  markdown: string;
}

export interface DocsPage {
  /** The page's path under `/docs/` (`members`, `install/local`); the docs home is `index`. */
  slug: string;
  title: string;
  description: string;
  sections: DocsSection[];
}

export const INTRO_SECTION = 'intro';

const SNAPSHOT_DIR = 'docs-snapshot';

/**
 * Where the snapshot is on disk. It is read at run time, so only the process
 * cwd can locate it: `apps/web` for the Next dev and standalone servers (the
 * Next config's `outputFileTracingIncludes` entry ships the directory), the
 * repo root for Vitest and root scripts.
 */
export function docsSnapshotDir(cwd: string = process.cwd()): string {
  const candidates = [join(cwd, SNAPSHOT_DIR), join(cwd, 'apps', 'web', SNAPSHOT_DIR)];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`Docs snapshot not found (looked in ${candidates.join(', ')})`);
  return found;
}

/** Every `.md` file under `dir`: page slug → Markdown source, in slug order. */
export function readDocsFiles(dir: string): Map<string, string> {
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.replace(/\\/g, '/'))
    .sort();
  return new Map(
    files.map((file) => [file.replace(/\.md$/, ''), readFileSync(join(dir, file), 'utf8')]),
  );
}

let snapshot: readonly DocsPage[] | undefined;

/** The snapshot's pages, read from disk once per process. */
export function loadDocs(): readonly DocsPage[] {
  snapshot ??= [...readDocsFiles(docsSnapshotDir())].map(([slug, source]) =>
    parseDocsPage(slug, source),
  );
  return snapshot;
}

/** One docs page, from its Markdown source with frontmatter. */
export function parseDocsPage(slug: string, source: string): DocsPage {
  const { fields, body } = splitFrontmatter(source);
  return {
    slug,
    title: fields.get('title') ?? '',
    description: fields.get('description') ?? '',
    sections: splitSections(body),
  };
}

export type DocsLookup =
  | { found: true; page: string; section: string; markdown: string }
  | { found: false; reason: 'unknown-page'; pages: string[] }
  | { found: false; reason: 'unknown-section'; page: string; sections: string[] };

/**
 * One section's Markdown. `section` is a section id or the heading itself. An
 * unknown page or section answers with the valid choices, so the model that
 * asked can correct itself.
 */
export function readDocsSection(
  pages: readonly DocsPage[],
  page: string,
  section: string,
): DocsLookup {
  // The docs link to each other as `/docs/<slug>`, which is what a model that
  // follows a link from a section it read passes back.
  const slug = page
    .trim()
    .replace(/^\/?(docs\/)?/, '')
    .replace(/\/$/, '');
  const found = pages.find((candidate) => candidate.slug === slug);
  if (!found) {
    return { found: false, reason: 'unknown-page', pages: pages.map(({ slug }) => slug) };
  }
  const id = sectionId(section);
  const match = found.sections.find((candidate) => candidate.id === id);
  if (!match) {
    return {
      found: false,
      reason: 'unknown-section',
      page: found.slug,
      sections: found.sections.map(({ heading }) => heading),
    };
  }
  return { found: true, page: found.slug, section: match.id, markdown: match.markdown };
}

/**
 * The table of contents the model picks a section from: per page its slug,
 * title and description, then one line per section heading.
 */
export function buildDocsIndex(pages: readonly DocsPage[]): string {
  return pages
    .map((page) =>
      [
        `${page.slug}: ${page.title}`,
        page.description,
        ...page.sections.map(({ heading }) => `- ${heading}`),
      ].join('\n'),
    )
    .join('\n\n');
}

function splitFrontmatter(source: string): { fields: Map<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  const fields = new Map<string, string>();
  if (!match?.[1]) return { fields, body: source };
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return { fields, body: source.slice(match[0].length) };
}

function splitSections(body: string): DocsSection[] {
  const sections: DocsSection[] = [];
  let heading = INTRO_SECTION;
  let lines: string[] = [];
  let inFence = false;

  const close = () => {
    const markdown = lines.join('\n').trim();
    if (markdown) sections.push({ id: sectionId(heading), heading, markdown });
  };

  for (const line of body.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    const match = inFence ? null : /^## (.+)$/.exec(line);
    if (match?.[1]) {
      close();
      heading = match[1].trim();
      lines = [];
    }
    lines.push(line);
  }
  close();
  return sections;
}

/**
 * The anchor the website gives a heading (GitHub-style slug). Slugging what a
 * caller asks for the same way lets a section be named by its id or its heading.
 */
function sectionId(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_ -]/gu, '')
    .trim()
    .replace(/ /g, '-');
}
