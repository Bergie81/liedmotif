// @vitest-environment jsdom

// The in-flight voice poller's fetch hygiene: completion-scheduled ticks (a
// slow response never stacks a second request), an AbortController released on
// unmount, and a visibility gate — profile creation runs for minutes, so a
// leaked or overlapping poller is real waste. The queue poller is the repo's
// reference pattern; this is the settings-surface twin. (`createElement`
// because web tests are `.test.ts` — see the root Vitest include.)

import { createElement } from 'react';
import { cleanup, render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceProfileView } from '@liedmotif/shared';
import { captureFetches } from '@/tests/helpers/capture-fetches';
import { MyVoiceSetup } from './my-voice-setup';

const IN_FLIGHT_POLL_MS = 4_000;

const IN_FLIGHT_VIEW: VoiceProfileView = {
  status: 'creating_voice',
  displayName: 'My voice',
  language: '',
  verificationPhrase: null,
  errorMessageSafe: null,
  hasSourceRecording: true,
  hasVerificationRecording: true,
  setupSupported: true,
  generationSupported: true,
  availableForSessions: false,
};

function renderInFlightSetup() {
  return render(createElement(MyVoiceSetup, { initial: IN_FLIGHT_VIEW }));
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

describe('MyVoiceSetup in-flight poller', () => {
  it('never overlaps: a slow response defers the next tick instead of stacking', async () => {
    const requests = captureFetches();
    renderInFlightSetup();

    await act(async () => {
      vi.advanceTimersByTime(IN_FLIGHT_POLL_MS);
    });
    expect(requests).toHaveLength(1);

    // The response is still pending — two more intervals must not fire more
    // requests (the next tick is armed only after the response settles).
    await act(async () => {
      vi.advanceTimersByTime(IN_FLIGHT_POLL_MS * 2);
    });
    expect(requests).toHaveLength(1);

    // Once it settles (still in flight), the next tick is scheduled.
    await act(async () => {
      requests[0]!.respond({ ok: true, data: { profile: IN_FLIGHT_VIEW } });
    });
    await act(async () => {
      vi.advanceTimersByTime(IN_FLIGHT_POLL_MS);
    });
    expect(requests).toHaveLength(2);
  });

  it('stops on unmount: the in-flight request aborts and no further tick fires', async () => {
    const requests = captureFetches();
    const { unmount } = renderInFlightSetup();

    await act(async () => {
      vi.advanceTimersByTime(IN_FLIGHT_POLL_MS);
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal?.aborted).toBe(false);

    unmount();
    expect(requests[0]!.signal?.aborted).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(IN_FLIGHT_POLL_MS * 3);
    });
    expect(requests).toHaveLength(1);
  });

  it('stretches the interval on repeated failure and snaps back after a success', async () => {
    // Pin jitter to zero so the failure delays are exact multiples of the base.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const requests = captureFetches();
    renderInFlightSetup();

    // First read at the normal cadence, then a failed response.
    await act(async () => {
      vi.advanceTimersByTime(IN_FLIGHT_POLL_MS);
    });
    expect(requests).toHaveLength(1);
    await act(async () => {
      requests[0]!.respond(null); // schema mismatch → ok: false
    });

    // One failure holds the base cadence; a second failure doubles it.
    await act(async () => {
      vi.advanceTimersByTime(IN_FLIGHT_POLL_MS);
    });
    expect(requests).toHaveLength(2);
    await act(async () => {
      requests[1]!.respond(null);
    });

    // Now backed off to 2× base: nothing fires at one interval, then it does.
    await act(async () => {
      vi.advanceTimersByTime(IN_FLIGHT_POLL_MS);
    });
    expect(requests).toHaveLength(2);
    await act(async () => {
      vi.advanceTimersByTime(IN_FLIGHT_POLL_MS);
    });
    expect(requests).toHaveLength(3);

    // A success resets the counter — the next tick is back at the base cadence.
    await act(async () => {
      requests[2]!.respond({ ok: true, data: { profile: IN_FLIGHT_VIEW } });
    });
    await act(async () => {
      vi.advanceTimersByTime(IN_FLIGHT_POLL_MS);
    });
    expect(requests).toHaveLength(4);
  });

  it('skips ticks while the tab is hidden and resumes when visible again', async () => {
    const requests = captureFetches();
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('hidden');
    renderInFlightSetup();

    await act(async () => {
      vi.advanceTimersByTime(IN_FLIGHT_POLL_MS * 3);
    });
    expect(requests).toHaveLength(0);

    visibility.mockReturnValue('visible');
    await act(async () => {
      vi.advanceTimersByTime(IN_FLIGHT_POLL_MS);
    });
    expect(requests).toHaveLength(1);
  });
});
