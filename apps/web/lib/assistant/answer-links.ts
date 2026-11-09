// Which of the links in an Assistant answer may be followed. The model can
// write any target, so nothing is followed unless it is on one of two lists the
// server hands the panel: the app pages this user can open, and the docs pages
// on the website.

import { DOCS_BASE_URL } from '@/lib/docs-links';

export interface AnswerLinkTargets {
  /** Paths of the app pages this user can open. */
  appPaths: readonly string[];
  /** Slugs of the docs pages on the website (`members`, `install/local`); the docs home is `index`. */
  docsPages: readonly string[];
}

export type AnswerLink =
  | { kind: 'app'; path: string }
  /** `url` is built here from a known slug, never copied from the answer. */
  | { kind: 'docs'; url: string };

const DOCS_HOME = 'index';

/** The website's origin, which a docs link may be written with. */
const SITE_ORIGIN = new URL(DOCS_BASE_URL).origin;

// `/docs`, then an optional page slug, an optional trailing slash, and an
// optional anchor shaped like the ones the website gives its headings. A query
// string never matches.
const DOCS_LINK = /^\/docs(?:\/([^#?]*?))?\/?(?:#([\p{L}\p{M}\p{N}_-]+))?$/u;

/**
 * What a link in an answer leads to, or `null` when it must stay plain text.
 *
 * - An app link is a path on the user's list, character for character: a query
 *   string, an anchor or a trailing slash is not on the list.
 * - A docs link is `/docs/<slug>` for a known page, written from the root or
 *   with the website's address, optionally with a heading anchor.
 */
export function resolveAnswerLink(
  href: string | undefined,
  targets: AnswerLinkTargets,
): AnswerLink | null {
  if (!href) return null;
  if (targets.appPaths.includes(href)) return { kind: 'app', path: href };

  const path = href.startsWith(`${SITE_ORIGIN}/`) ? href.slice(SITE_ORIGIN.length) : href;
  const match = DOCS_LINK.exec(path);
  if (!match) return null;
  const slug = match[1] || DOCS_HOME;
  if (!targets.docsPages.includes(slug)) return null;
  const anchor = match[2] ? `#${match[2]}` : '';
  return { kind: 'docs', url: `${DOCS_BASE_URL}${slug === DOCS_HOME ? '' : `${slug}/`}${anchor}` };
}
