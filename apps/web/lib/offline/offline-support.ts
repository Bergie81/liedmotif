// Whether this page can keep music Available offline. Offline storage needs a
// secure context (HTTPS, or localhost), the same bar the service worker that
// plays it back offline sets; over plain HTTP the app runs normally and simply
// offers no offline toggle. Client-side only: the server cannot know how the
// page was opened.

export function offlineSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && 'indexedDB' in window;
}
