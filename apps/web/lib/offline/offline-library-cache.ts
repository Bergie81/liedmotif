// The Offline Library's copy on this device: the page and every static file it
// loads, held in one Cache Storage cache so the service worker (`public/sw.js`)
// can show it when a page navigation fails for want of a network. The app
// refreshes it on every open while online, so a deploy reaches it with the
// next visit; the service worker itself only reads it.
//
// The page is a static, client-only render, so its HTML names what it loads:
// scripts, stylesheets, preloaded fonts, and the client chunks in its inline
// payload. Stylesheets name the remaining fonts and images; in development,
// Turbopack's chunk lists inside scripts name a few more.

/** Shared with `public/sw.js`, which cannot import this module. */
export const OFFLINE_LIBRARY_CACHE = 'liedmotif-offline-library';
export const OFFLINE_LIBRARY_PATH = '/offline';
const SERVICE_WORKER_PATH = '/sw.js';

/** Where the static files the page loads live: Next's build output, and the
 *  public textures its stylesheets name. `public/sw.js` serves the same two. */
const STATIC_PREFIXES = ['/_next/static/', '/textures/'];
/** Resolves relative references; only the path is kept. */
const PATH_BASE = 'https://offline-library.invalid';

/** A page names absolute paths (its inline payload's quotes come escaped). */
const PAGE_REFERENCE = /\/_next\/static\/[^"'\s\\()<>]+/g;
/** A Turbopack chunk list in a script names chunks relative to `/_next/`. */
const CHUNK_LIST_REFERENCE = /"(static\/chunks\/[^"]+)"/g;
const STYLESHEET_REFERENCE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** The path as the browser requests it: each segment percent-encoded once,
 *  as Next writes it into HTML and Turbopack's runtime loads it. */
function requestPath(url: URL): string {
  const pathname = url.pathname
    .split('/')
    .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
    .join('/');
  return pathname + url.search;
}

/** What `text`, served at `path`, names: a script only its chunk lists, a
 *  stylesheet its `url(...)`s, a page every static path in it. */
function referencesIn(text: string, path: string): string[] {
  const url = new URL(path, PATH_BASE);
  if (url.pathname.endsWith('.js')) {
    return [...text.matchAll(CHUNK_LIST_REFERENCE)].map(([, chunk]) => `/_next/${chunk}`);
  }
  if (url.pathname.endsWith('.css')) {
    return [...text.matchAll(STYLESHEET_REFERENCE)].map(
      ([, , reference]) => new URL(reference!, url).href,
    );
  }
  return text.match(PAGE_REFERENCE) ?? [];
}

/** The same-origin static files `text`, served at `path`, names. */
function staticPathsIn(text: string, path: string): string[] {
  return referencesIn(text, path).flatMap((reference) => {
    const url = new URL(reference, PATH_BASE);
    if (url.origin !== PATH_BASE) return [];
    if (!STATIC_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return [];
    return [requestPath(url)];
  });
}

async function read(fetcher: typeof fetch, path: string, init?: RequestInit): Promise<Response> {
  const response = await fetcher(path, init);
  if (!response.ok) throw new Error(`Offline Library file ${path} answered ${response.status}.`);
  return response;
}

/** Every static file the page `html` loads, by path, each read through `load`.
 *  Throws when one cannot be read. */
async function filesOf(
  html: string,
  load: (path: string) => Promise<Response | undefined>,
): Promise<Map<string, Response>> {
  const files = new Map<string, Response>();
  const pending = staticPathsIn(html, OFFLINE_LIBRARY_PATH);
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (files.has(path)) continue;
    const response = await load(path);
    if (!response) throw new Error(`Offline Library file ${path} is missing.`);
    files.set(path, response);
    if (/\.(?:css|js)$/.test(new URL(path, PATH_BASE).pathname)) {
      pending.push(...staticPathsIn(await response.clone().text(), path));
    }
  }
  return files;
}

/**
 * Caches the Offline Library and its files, replacing an earlier build's copy.
 * Throws when any file cannot be read; the cached copy then stays as it was,
 * because the page is written only after every file it loads.
 */
export async function cacheOfflineLibrary(deps: {
  fetch: typeof fetch;
  caches: CacheStorage;
}): Promise<void> {
  const cache = await deps.caches.open(OFFLINE_LIBRARY_CACHE);
  const page = await read(deps.fetch, OFFLINE_LIBRARY_PATH, { cache: 'no-store' });
  const html = await page.clone().text();
  const held = await cache.match(OFFLINE_LIBRARY_PATH);
  if (held && (await held.text()) === html) {
    // The same page is not yet a whole copy: two refreshes racing across a
    // deploy can each delete the files the other one cached.
    const whole = await filesOf(html, (path) => cache.match(path)).then(
      () => true,
      () => false,
    );
    if (whole) return;
  }

  const files = await filesOf(html, (path) => read(deps.fetch, path));
  for (const [path, response] of files) await cache.put(path, response);
  await cache.put(OFFLINE_LIBRARY_PATH, page);
  for (const request of await cache.keys()) {
    const url = new URL(request.url);
    const path = url.pathname + url.search;
    if (path !== OFFLINE_LIBRARY_PATH && !files.has(path)) await cache.delete(request);
  }
}

/**
 * Installs the service worker and refreshes the Offline Library it falls back
 * to. Best-effort: a device that cannot keep it shows the browser's own offline
 * page instead.
 */
export async function readyOfflineLibrary(): Promise<void> {
  if (!('serviceWorker' in navigator) || typeof caches === 'undefined') return;
  try {
    await navigator.serviceWorker.register(SERVICE_WORKER_PATH);
    await cacheOfflineLibrary({ fetch: (input, init) => fetch(input, init), caches });
  } catch {
    // Tried again on the next app open.
  }
}
