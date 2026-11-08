// @vitest-environment jsdom

// The app-wide online state: the browser's own connection flag, plus failed
// requests, so a tab that still believes it is online while the server is gone
// also goes listen-only.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isOnline,
  reportServerAnswered,
  reportServerUnreachable,
  subscribeOnline,
} from '@/lib/online-state';

let browserOnline = true;
Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => browserOnline });

function setBrowserOnline(online: boolean) {
  browserOnline = online;
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}

/** Each probe the state sends, held open until the test answers or fails it. */
const probes: Array<{ answer: () => void; fail: () => void }> = [];

beforeEach(() => {
  vi.useFakeTimers();
  probes.length = 0;
  vi.stubGlobal(
    'fetch',
    () =>
      new Promise<Response>((resolve, reject) => {
        probes.push({
          answer: () => resolve(new Response(null, { status: 503 })),
          fail: () => reject(new TypeError('Failed to fetch')),
        });
      }),
  );
});

afterEach(() => {
  setBrowserOnline(true);
  reportServerAnswered();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('online state', () => {
  it('follows the browser going offline and back online', () => {
    expect(isOnline()).toBe(true);

    setBrowserOnline(false);
    expect(isOnline()).toBe(false);

    setBrowserOnline(true);
    expect(isOnline()).toBe(true);
  });

  it('goes offline on a failed request while the browser says online, and back once a probe reaches the server', async () => {
    reportServerUnreachable();
    expect(isOnline()).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(probes).toHaveLength(1);
    probes[0]!.fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(isOnline()).toBe(false);

    // The next probe waits longer than the first.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(probes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(probes).toHaveLength(2);
    // Any answer counts, an unhealthy one too: the server is there.
    probes[1]!.answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(isOnline()).toBe(true);
  });

  it('waits out a browser outage without probing, then probes as soon as it is back', async () => {
    reportServerUnreachable();
    setBrowserOnline(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(probes).toHaveLength(0);

    setBrowserOnline(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(probes).toHaveLength(1);
    expect(isOnline()).toBe(false);
    probes[0]!.answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(isOnline()).toBe(true);
  });

  it('ends an outage on any answered request and tells subscribers only of real changes', async () => {
    const changes: boolean[] = [];
    const unsubscribe = subscribeOnline(() => changes.push(isOnline()));

    reportServerUnreachable();
    reportServerUnreachable();
    reportServerAnswered();
    reportServerAnswered();
    unsubscribe();
    expect(changes).toEqual([false, true]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(probes).toHaveLength(0);
  });
});
