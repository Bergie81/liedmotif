// @vitest-environment jsdom

// Shuffle is known only to the device, so the queue poll itself asks for the
// whole Session while it is selected: the windowed read holds only the last
// 30 slots behind the current Track, and Shuffle must reach every Track.
// (`createElement` because web tests are `.test.ts` — see the root Vitest include.)

import { createElement } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureFetches } from '@/tests/helpers/capture-fetches';
import { QUEUE_POLL_QUIET_MS } from './queue-poller';
import { useSessionQueue } from './use-session-queue';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const notRemoved = () => false;
const ignoreSnapshot = () => {};
const notPlaying = () => false;

function Probe({ shuffle }: { shuffle: boolean }) {
  useSessionQueue(SESSION_ID, notRemoved, ignoreSnapshot, notPlaying, shuffle);
  return null;
}

const asksForFullRead = (path: string) =>
  new URL(path, 'http://localhost').searchParams.get('full') === '1';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the Session queue poll under Shuffle', () => {
  it('reads the whole Session while Shuffle is selected, and the window otherwise', async () => {
    const requests = captureFetches();
    const view = render(createElement(Probe, { shuffle: false }));
    expect(requests).toHaveLength(1);
    expect(asksForFullRead(requests[0]!.path)).toBe(false);
    await act(async () => {
      requests[0]!.respond(null);
    });

    // Selecting Shuffle polls at once, without the window.
    view.rerender(createElement(Probe, { shuffle: true }));
    expect(requests).toHaveLength(2);
    expect(asksForFullRead(requests[1]!.path)).toBe(true);
    await act(async () => {
      requests[1]!.respond(null);
    });

    // Every later poll while Shuffle stays selected is a full read too.
    await act(async () => {
      vi.advanceTimersByTime(QUEUE_POLL_QUIET_MS);
    });
    expect(requests).toHaveLength(3);
    expect(asksForFullRead(requests[2]!.path)).toBe(true);
    await act(async () => {
      requests[2]!.respond(null);
    });

    // Leaving Shuffle returns to the windowed read.
    view.rerender(createElement(Probe, { shuffle: false }));
    expect(requests).toHaveLength(4);
    expect(asksForFullRead(requests[3]!.path)).toBe(false);
  });
});
