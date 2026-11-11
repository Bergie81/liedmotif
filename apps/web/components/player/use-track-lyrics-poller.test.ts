// @vitest-environment jsdom

// The pending-lyrics poll's failure backoff: a 5xx-ing endpoint must not be
// re-hit at the fixed 5s cadence, but an OK-but-unsettled read (the words are
// still being written) must stay at the normal cadence — that success-path
// timing is what the sleeve's perceived responsiveness rides on. (`createElement`
// because web tests are `.test.ts` — see the root Vitest include.)

import { createElement } from 'react';
import { cleanup, render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureFetches } from '@/tests/helpers/capture-fetches';
import { useLyricsSurface } from './use-track-lyrics';

const PENDING_POLL_MS = 5_000;
const PENDING_BODY = {
  ok: true,
  data: { state: 'pending', lines: [], synced: false, settled: false },
};

function Probe() {
  useLyricsSurface({
    trackId: 'track-1',
    enabled: true,
    getPlaybackSample: () => ({ positionSeconds: 0, durationSeconds: 100, playbackRate: 1 }),
  });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useLyricsSurface pending poll', () => {
  it('backs off on failure but keeps the base cadence for an OK-but-unsettled read', async () => {
    // Pin jitter to zero so the failure delays are exact multiples of the base.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const requests = captureFetches();
    render(createElement(Probe));

    // The hook reads immediately on open; a failed read arms one backoff step.
    expect(requests).toHaveLength(1);
    await act(async () => {
      requests[0]!.respond(null); // schema mismatch → ok: false
    });

    // One failure holds the base cadence; a second failure doubles it.
    await act(async () => {
      vi.advanceTimersByTime(PENDING_POLL_MS);
    });
    expect(requests).toHaveLength(2);
    await act(async () => {
      requests[1]!.respond(null);
    });
    await act(async () => {
      vi.advanceTimersByTime(PENDING_POLL_MS);
    });
    expect(requests).toHaveLength(2); // backed off to 2× base — nothing yet
    await act(async () => {
      vi.advanceTimersByTime(PENDING_POLL_MS);
    });
    expect(requests).toHaveLength(3);

    // An OK-but-unsettled read resets the counter: the poll snaps back to 5s.
    await act(async () => {
      requests[2]!.respond(PENDING_BODY);
    });
    await act(async () => {
      vi.advanceTimersByTime(PENDING_POLL_MS);
    });
    expect(requests).toHaveLength(4);
  });

  it('keeps the words already shown when a later read fails', async () => {
    let surface: ReturnType<typeof useLyricsSurface> | null = null;
    function Shown() {
      surface = useLyricsSurface({
        trackId: 'track-1',
        enabled: true,
        getPlaybackSample: () => ({ positionSeconds: 0, durationSeconds: 100, playbackRate: 1 }),
      });
      return null;
    }
    const requests = captureFetches();
    render(createElement(Shown));

    await act(async () => {
      requests[0]!.respond({
        ok: true,
        data: {
          state: 'ready',
          lines: [{ kind: 'line', text: 'Hello night', timeSeconds: null }],
          synced: false,
          settled: false,
        },
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(PENDING_POLL_MS);
    });
    await act(async () => {
      requests[1]!.respond(null);
    });

    expect(surface!.phase).toBe('lines');
    expect(surface!.lines).toHaveLength(1);
    expect(surface!.settled).toBe(false);
  });
});
