// The app's one answer to "can this tab reach the server?". Offline means
// listen-only: actions that need the server are disabled instead of left to
// fail. The browser's own flag cannot see a server that is down behind a
// working network, so a request that fails in transit counts too, and from then
// on a cheap probe asks until the server answers again.
//
// Plain modules read `isOnline` / `subscribeOnline`; React reads `useOnline`.

import { useSyncExternalStore } from 'react';
import { pollBackoffMs } from './poll-backoff';

/** First wait before asking an unreachable server again; repeats double up to the cap. */
const PROBE_BASE_MS = 2_000;
const PROBE_MAX_MS = 30_000;
/** Needs no session, and any answer at all proves the server reachable. */
const PROBE_URL = '/api/health';

let started = false;
let browserOnline = true;
let serverReachable = true;
let failedProbes = 0;
// Stays set while its probe is in flight, so a failed request arriving
// meanwhile never starts a second probe.
let probeTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

/**
 * Follows the browser's flag from the first use on. False outside a browser:
 * a server render has no connection to lose and always counts as online.
 */
function live(): boolean {
  if (typeof window === 'undefined') return false;
  if (!started) {
    started = true;
    browserOnline = navigator.onLine;
    window.addEventListener('online', followBrowser);
    window.addEventListener('offline', followBrowser);
  }
  return true;
}

function update(change: () => void): void {
  const before = isOnline();
  change();
  if (isOnline() !== before) for (const listener of listeners) listener();
}

// A probe without a network only fails; one right after the network returns
// ends a server outage without waiting out the backoff.
function followBrowser(): void {
  update(() => {
    browserOnline = navigator.onLine;
  });
  cancelProbe();
  if (browserOnline) scheduleProbe(0);
}

function cancelProbe(): void {
  if (probeTimer !== null) clearTimeout(probeTimer);
  probeTimer = null;
}

function scheduleProbe(
  delay = pollBackoffMs({ failures: failedProbes + 1, baseMs: PROBE_BASE_MS, maxMs: PROBE_MAX_MS }),
): void {
  if (probeTimer !== null || serverReachable || !browserOnline) return;
  probeTimer = setTimeout(() => {
    fetch(PROBE_URL, { cache: 'no-store' }).then(reportServerAnswered, () => {
      probeTimer = null;
      failedProbes += 1;
      scheduleProbe();
    });
  }, delay);
}

/** Whether actions that need the server can run now. */
export function isOnline(): boolean {
  return !live() || (browserOnline && serverReachable);
}

export function subscribeOnline(listener: () => void): () => void {
  if (!live()) return () => {};
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For fetch wrappers: a request got an answer, whatever its status. */
export function reportServerAnswered(): void {
  if (!live()) return;
  cancelProbe();
  failedProbes = 0;
  update(() => {
    serverReachable = true;
  });
}

/** For fetch wrappers: a request failed in transit. Never report an abort. */
export function reportServerUnreachable(): void {
  if (!live()) return;
  update(() => {
    serverReachable = false;
  });
  scheduleProbe();
}

/** {@link isOnline} for components. The server render and hydration assume online. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, isOnline, () => true);
}
