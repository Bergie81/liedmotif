// Liedmotif's service worker. It has one job: when a page navigation fails for
// want of a network, show the Offline Library — the static page the app caches
// in `liedmotif-offline-library` on every open (apps/web/lib/offline/
// offline-library-cache.ts, which owns both names below).
//
// Online, everything goes to the network exactly as it would without this
// worker, and nothing here writes a cache, so it can never serve a stale app
// page. `/api/*` is never touched: audio (whose Range requests Safari needs),
// covers and every other server read or write pass straight through. Offline
// audio comes from the device's offline store as object URLs instead.

const OFFLINE_LIBRARY_CACHE = 'liedmotif-offline-library';
const OFFLINE_LIBRARY_PATH = '/offline';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Navigation preload keeps an online page load from waiting on this
      // worker to start.
      await self.registration.navigationPreload?.enable();
      await self.clients.claim();
    })(),
  );
});

async function cached(path) {
  const cache = await caches.open(OFFLINE_LIBRARY_CACHE);
  return cache.match(path);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return (await event.preloadResponse) ?? (await fetch(request));
        } catch {
          return (await cached(OFFLINE_LIBRARY_PATH)) ?? Response.error();
        }
      })(),
    );
    return;
  }

  // The Offline Library's own scripts, styles and fonts, as the network serves
  // them while it can. With no network at all, the cached copy answers first,
  // rather than after a request that can only fail; what it lacks still goes
  // out (a server on this machine answers without one).
  if (url.pathname.startsWith('/_next/static/')) {
    const path = url.pathname + url.search;
    event.respondWith(
      (async () => {
        if (!self.navigator.onLine) return (await cached(path)) ?? fetch(request);
        try {
          return await fetch(request);
        } catch (error) {
          const copy = await cached(path);
          if (copy) return copy;
          throw error;
        }
      })(),
    );
  }
});
