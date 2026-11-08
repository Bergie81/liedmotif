// The docs live once, on the Liedmotif website; the app only links to them.
// Every path the app's code links to is listed here, so one test can check them
// all against the site's pages and heading anchors; the same test scans shipped
// scripts and config for the URLs they write out.

export const DOCS_BASE_URL = 'https://liedmotif.com/docs/';

export const DOCS_PATHS = [
  '',
  'providers-and-keys',
  'providers-and-keys#when-credits-run-out',
  'costs-and-limits',
  'backups',
  'members',
  'alerts',
] as const;

export type DocsPath = (typeof DOCS_PATHS)[number];

/** `page#anchor` → `<DOCS_BASE_URL>page/#anchor`; `''` is the docs home. */
export function docsUrl(path: DocsPath = ''): string {
  const [page = '', anchor] = path.split('#');
  return `${DOCS_BASE_URL}${page ? `${page}/` : ''}${anchor ? `#${anchor}` : ''}`;
}
