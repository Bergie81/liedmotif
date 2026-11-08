// @vitest-environment jsdom

// Listening while offline is not recorded or synced later. A live tab that
// loses its connection keeps playing — buffered audio, or a Track this device
// stores — but reports are cumulative, so time the meter credited offline would
// reach the server with the first report after the connection returns.

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createListeningMeter, type ListeningReport } from './listening-meter';
import { useListeningMeter } from './use-listening-meter';

const sent = vi.hoisted(() => [] as ListeningReport[]);

vi.mock('./listening-sender', () => ({
  createReportingMeter: () =>
    createListeningMeter({
      send: (report) => sent.push(report),
      now: Date.now,
      newOccurrenceId: () => 'occurrence-1',
    }),
  flushOnPageHide: () => () => undefined,
}));

let browserOnline = true;

function setBrowserOnline(online: boolean) {
  browserOnline = online;
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  browserOnline = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => browserOnline });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('credits none of the time a live tab plays while offline, also once it is back online', () => {
  let position = 0;
  const { result } = renderHook(() => useListeningMeter(true, () => ({ position, audible: true })));
  const play = (seconds: number) => {
    for (let i = 0; i < seconds; i++) {
      position += 1;
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
  };

  result.current().begin({ trackId: 't1', sessionId: 's1', surface: 'session' });
  play(5);
  setBrowserOnline(false);
  play(60);
  setBrowserOnline(true);
  play(5);
  result.current().flush();

  const playedMs = sent.at(-1)!.playedMs;
  expect(playedMs).toBeGreaterThanOrEqual(9_000);
  expect(playedMs).toBeLessThanOrEqual(11_000);
});
