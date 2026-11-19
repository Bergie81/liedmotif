// @vitest-environment jsdom

// Offline is listen-only: the shared fetch wrappers send no server action while
// offline, so even a control that missed its offline state fires nothing, and a
// Skip or a listening report made offline is dropped rather than kept for
// later. Reads still go out: an answered one is how a dead server's comeback is
// noticed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChrome, reportListening, sendFeedback } from './api-client';
import { apiFetchJson } from './api-fetch';
import { isOnline, reportServerAnswered } from '@/lib/online-state';

let browserOnline = true;
Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => browserOnline });

function setBrowserOnline(online: boolean) {
  browserOnline = online;
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(Response.json({ ok: true, data: null }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  setBrowserOnline(true);
  reportServerAnswered();
  vi.unstubAllGlobals();
});

describe('server actions while offline', () => {
  it('are refused without a request, a Skip and a listening report included', async () => {
    setBrowserOnline(false);

    const skip = await sendFeedback({
      trackId: 'track-1',
      sessionId: 'session-1',
      type: 'skip',
      value: null,
      freeformText: null,
    });
    const listening = await reportListening({
      occurrenceId: 'occurrence-1',
      trackId: 'track-1',
      sessionId: null,
      surface: 'playlist',
      startedAt: '2026-11-04T10:00:00.000Z',
      origin: 'auto',
      listenedMs: 12_000,
      playedMs: 12_000,
      clientTimestamp: '2026-11-04T10:00:12.000Z',
      endReason: null,
    });
    const saved = await apiFetchJson('/api/settings/people', 'POST', { name: 'Mara' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(skip.ok).toBe(false);
    expect(listening.ok).toBe(false);
    expect(saved.ok).toBe(false);
    if (!skip.ok) expect(skip.error.message).toMatch(/offline/i);
  });

  it('still lets reads go out', async () => {
    setBrowserOnline(false);
    await getChrome();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('a request that fails in transit', () => {
  it('takes the app offline while the browser still says online', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await getChrome();
    expect(isOnline()).toBe(false);
  });

  it('is not an outage when the caller aborted it', async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await getChrome(controller.signal);
    expect(isOnline()).toBe(true);
  });
});
