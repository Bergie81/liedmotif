import { describe, expect, it } from 'vitest';
import {
  cacheOfflineLibrary,
  OFFLINE_LIBRARY_CACHE,
  OFFLINE_LIBRARY_PATH,
} from './offline-library-cache';

// The Offline Library page the service worker falls back to: one cache holds
// the page and every static file it loads, so it renders with no connection.
// Only a complete set ever replaces the cached one.

const PAGE = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="/_next/static/chunks/app.css" data-precedence="next"/>
<link rel="preload" href="/_next/static/media/body-font.woff2" as="font" crossorigin=""/>
<link rel="icon" href="/icon.svg?f0e1" type="image/svg+xml"/>
<script src="/_next/static/chunks/main.js" async=""></script>
</head><body><main>Offline Library</main>
<script>self.__next_f.push([1,"2:I[\\"/_next/static/chunks/player.js\\",[]]"])</script>
</body></html>`;

const STYLESHEET = `@font-face{font-family:mono;src:url(../media/mono-font.woff2) format("woff2")}
body{background:url(/_next/static/media/grain.png)}`;

/** A Turbopack chunk list names its chunks relative to `/_next/`, unencoded. */
const CHUNK_LIST = `TURBOPACK_CHUNK_LISTS.push({chunks:["static/chunks/[turbopack]_runtime.js"]})`;

const NEXT_PAGE = PAGE.replace('/_next/static/chunks/main.js', '/_next/static/chunks/main-v2.js');

function memoryCaches() {
  const entries = new Map<string, Response>();
  const cache = {
    async match(request: RequestInfo | URL) {
      return entries.get(pathOf(request))?.clone();
    },
    async put(request: RequestInfo | URL, response: Response) {
      entries.set(pathOf(request), response);
    },
    async keys() {
      return [...entries.keys()].map((path) => new Request(new URL(path, ORIGIN)));
    },
    async delete(request: RequestInfo | URL) {
      return entries.delete(pathOf(request));
    },
  };
  const caches = {
    async open(name: string) {
      if (name !== OFFLINE_LIBRARY_CACHE) throw new Error(`unexpected cache ${name}`);
      return cache;
    },
  } as unknown as CacheStorage;
  return { caches, paths: () => [...entries.keys()].sort() };
}

const ORIGIN = 'https://liedmotif.test';

function pathOf(request: RequestInfo | URL): string {
  const url = new URL(
    typeof request === 'string' || request instanceof URL ? request : request.url,
    ORIGIN,
  );
  return url.pathname + url.search;
}

function server(files: Record<string, string>) {
  const requested: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const path = pathOf(input);
    requested.push(path);
    const body = files[path];
    if (body === undefined) return new Response('missing', { status: 404 });
    return new Response(body, { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, requested };
}

const ASSETS = {
  '/_next/static/chunks/app.css': STYLESHEET,
  '/_next/static/media/body-font.woff2': 'font',
  '/_next/static/media/mono-font.woff2': 'font',
  '/_next/static/media/grain.png': 'png',
  '/_next/static/chunks/main.js': CHUNK_LIST,
  '/_next/static/chunks/%5Bturbopack%5D_runtime.js': 'js',
  '/_next/static/chunks/main-v2.js': 'js v2',
  '/_next/static/chunks/player.js': 'js',
};

describe('cacheOfflineLibrary', () => {
  it('caches the page with every static file it loads, those its scripts and stylesheets name included', async () => {
    const { caches, paths } = memoryCaches();
    const { fetch } = server({ [OFFLINE_LIBRARY_PATH]: PAGE, ...ASSETS });

    await cacheOfflineLibrary({ fetch, caches });

    expect(paths()).toEqual([
      '/_next/static/chunks/%5Bturbopack%5D_runtime.js',
      '/_next/static/chunks/app.css',
      '/_next/static/chunks/main.js',
      '/_next/static/chunks/player.js',
      '/_next/static/media/body-font.woff2',
      '/_next/static/media/grain.png',
      '/_next/static/media/mono-font.woff2',
      OFFLINE_LIBRARY_PATH,
    ]);
  });

  it('replaces an earlier build with the new one, leaving nothing of the old behind', async () => {
    const { caches, paths } = memoryCaches();
    await cacheOfflineLibrary({
      fetch: server({ [OFFLINE_LIBRARY_PATH]: PAGE, ...ASSETS }).fetch,
      caches,
    });

    await cacheOfflineLibrary({
      fetch: server({ [OFFLINE_LIBRARY_PATH]: NEXT_PAGE, ...ASSETS }).fetch,
      caches,
    });

    expect(paths()).toContain('/_next/static/chunks/main-v2.js');
    expect(paths()).not.toContain('/_next/static/chunks/main.js');
    const page = await (await caches.open(OFFLINE_LIBRARY_CACHE)).match(OFFLINE_LIBRARY_PATH);
    expect(await page!.text()).toBe(NEXT_PAGE);
  });

  it('asks only for the page while it has not changed', async () => {
    const { caches } = memoryCaches();
    await cacheOfflineLibrary({
      fetch: server({ [OFFLINE_LIBRARY_PATH]: PAGE, ...ASSETS }).fetch,
      caches,
    });

    const again = server({ [OFFLINE_LIBRARY_PATH]: PAGE, ...ASSETS });
    await cacheOfflineLibrary({ fetch: again.fetch, caches });

    expect(again.requested).toEqual([OFFLINE_LIBRARY_PATH]);
  });

  // Two refreshes racing across a deploy can each delete the other's files,
  // leaving the newer page cached without some of what it loads.
  it('fetches the library again when its page has not changed but a file it loads is gone', async () => {
    const { caches, paths } = memoryCaches();
    await cacheOfflineLibrary({
      fetch: server({ [OFFLINE_LIBRARY_PATH]: PAGE, ...ASSETS }).fetch,
      caches,
    });
    const whole = paths();
    await (await caches.open(OFFLINE_LIBRARY_CACHE)).delete('/_next/static/media/mono-font.woff2');

    await cacheOfflineLibrary({
      fetch: server({ [OFFLINE_LIBRARY_PATH]: PAGE, ...ASSETS }).fetch,
      caches,
    });

    expect(paths()).toEqual(whole);
  });

  it('keeps the cached library whole when a file of the new one cannot be read', async () => {
    const { caches, paths } = memoryCaches();
    await cacheOfflineLibrary({
      fetch: server({ [OFFLINE_LIBRARY_PATH]: PAGE, ...ASSETS }).fetch,
      caches,
    });
    const before = paths();

    const { '/_next/static/chunks/main-v2.js': _missing, ...withoutNewChunk } = ASSETS;
    await expect(
      cacheOfflineLibrary({
        fetch: server({ [OFFLINE_LIBRARY_PATH]: NEXT_PAGE, ...withoutNewChunk }).fetch,
        caches,
      }),
    ).rejects.toThrow();

    expect(paths()).toEqual(before);
    const page = await (await caches.open(OFFLINE_LIBRARY_CACHE)).match(OFFLINE_LIBRARY_PATH);
    expect(await page!.text()).toBe(PAGE);
  });
});
